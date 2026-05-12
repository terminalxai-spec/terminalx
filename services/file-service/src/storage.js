const fs = require("node:fs");
const path = require("node:path");
const { getRuntimeConfig } = require("../../agent-runtime/src/config/runtime");
const { createStorageProvider, safeStorageKey } = require("./providers");

function nowIso() {
  return new Date().toISOString();
}

function storageConfig() {
  const runtime = getRuntimeConfig();
  return {
    mode: runtime.mode,
    provider: process.env.FILE_STORAGE_PROVIDER || process.env.STORAGE_PROVIDER || (runtime.isOfflineMode ? "local" : "local"),
    localPath: process.env.FILE_STORAGE_LOCAL_PATH || process.env.STORAGE_LOCAL_PATH || "./storage/local/files",
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    supabaseBucket: process.env.SUPABASE_STORAGE_BUCKET || "",
    s3Endpoint: process.env.S3_ENDPOINT || "",
    s3Bucket: process.env.S3_BUCKET || "",
    s3Region: process.env.S3_REGION || "auto",
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ""
  };
}

function localStorageRoot() {
  return path.resolve(process.cwd(), storageConfig().localPath);
}

function safeStoragePath(storagePath) {
  const normalized = String(storagePath || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error("Invalid storage path.");
  }
  return normalized;
}

function encodeContent({ content = "", encoding = "utf8" }) {
  if (encoding === "base64") {
    return Buffer.from(content, "base64");
  }
  return Buffer.from(String(content), "utf8");
}

function metadataForRecord(record) {
  const config = storageConfig();
  return {
    ...record,
    mode: config.mode,
    provider: config.provider,
    storage_provider: config.provider,
    storage_key: record.path,
    size: record.size_bytes,
    bucket: config.supabaseBucket || config.s3Bucket || "local",
    onlineConfigured:
      (config.provider === "supabase" && Boolean(config.supabaseUrl && config.supabaseServiceRoleKey && config.supabaseBucket)) ||
      (config.provider === "s3" && Boolean(config.s3Endpoint && config.s3Bucket && config.s3AccessKeyId && config.s3SecretAccessKey))
  };
}

function createStorageService({ files = [], fileRepository = null, approvalQueue, appendTaskHistory, provider = null, providerOptions = {} }) {
  function activeProvider() {
    return provider || createStorageProvider(storageConfig(), providerOptions);
  }

  function addOrReplaceRecord(record) {
    if (fileRepository) {
      return fileRepository.upsertFile(record);
    }

    const existingIndex = files.findIndex((file) => file.id === record.id);
    if (existingIndex >= 0) {
      files[existingIndex] = record;
      return record;
    }
    files.unshift(record);
    return record;
  }

  async function upload(payload) {
    const filename = payload.filename || path.basename(payload.path || "upload.txt");
    const taskId = payload.task_id || null;
    const storagePath = safeStorageKey(payload.path || `${taskId || "unassigned"}/${filename}`);
    const content = encodeContent(payload);
    const id = payload.id || `file_${Date.now()}`;
    const selectedProvider = activeProvider();

    await selectedProvider.uploadFile({
      key: storagePath,
      content,
      mimeType: payload.mime_type || "application/octet-stream"
    });

    const downloadUrl = await selectedProvider.getDownloadUrl(storagePath);

    const record = metadataForRecord({
      id,
      task_id: taskId,
      filename,
      path: storagePath,
      mime_type: payload.mime_type || "application/octet-stream",
      size_bytes: content.length,
      download_url: downloadUrl,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    addOrReplaceRecord(record);
    approvalQueue.logAction("file.uploaded", {
      fileId: record.id,
      taskId,
      path: record.path,
      provider: record.provider
    });
    appendTaskHistory?.(taskId, "file.uploaded", record);

    return record;
  }

  function list(filter = {}) {
    if (fileRepository) {
      return fileRepository.listFiles(filter);
    }

    if (!filter.task_id) {
      return files;
    }
    return files.filter((file) => file.task_id === filter.task_id);
  }

  function get(fileId) {
    if (fileRepository) {
      return fileRepository.getFile(fileId);
    }

    return files.find((file) => file.id === fileId) || null;
  }

  async function read(fileId) {
    const record = get(fileId);
    if (!record) {
      return null;
    }

    const content = await activeProvider().readFile(record.storage_key || record.path);
    return {
      file: record,
      content: content.toString("utf8")
    };
  }

  async function download(fileId) {
    const record = get(fileId);
    if (!record) {
      return null;
    }

    return {
      file: record,
      content: await activeProvider().readFile(record.storage_key || record.path)
    };
  }

  async function remove({ fileId, approvalId }) {
    const record = get(fileId);
    if (!record) {
      return null;
    }

    if (!approvalId || !approvalQueue.isApproved(approvalId)) {
      const approval = approvalQueue.add({
        title: `Approve storage delete: ${record.filename}`,
        requestedBy: "file-service",
        approvalType: "file_deletion",
        riskLevel: "critical",
        description: `Deleting stored file requires approval: ${record.path}`,
        proposedAction: {
          tool: "storage.delete",
          fileId,
          path: record.path,
          taskId: record.task_id
        }
      });

      return {
        status: "approval_required",
        approval_required: true,
        approval_id: approval.id,
        file: record
      };
    }

    await activeProvider().deleteFile(record.storage_key || record.path);

    if (fileRepository) {
      fileRepository.deleteFile(fileId);
    } else {
      const index = files.findIndex((file) => file.id === fileId);
      if (index >= 0) {
        files.splice(index, 1);
      }
    }

    approvalQueue.logAction("file.deleted", {
      approvalId,
      fileId,
      path: record.path,
      taskId: record.task_id,
      provider: record.provider
    });
    appendTaskHistory?.(record.task_id, "file.deleted", record);

    return {
      status: "deleted",
      approval_required: false,
      file: record
    };
  }

  return {
    config: storageConfig,
    download,
    get,
    list,
    read,
    remove,
    upload
  };
}

module.exports = { createStorageService };
