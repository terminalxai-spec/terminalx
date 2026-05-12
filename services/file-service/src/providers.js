const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function safeStorageKey(key) {
  const normalized = String(key || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error("Invalid storage key.");
  }
  return normalized;
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class LocalStorageProvider {
  constructor({ root = "./storage/local/files" } = {}) {
    this.id = "local";
    this.root = path.resolve(process.cwd(), root);
  }

  fullPath(key) {
    return path.join(this.root, safeStorageKey(key));
  }

  async uploadFile({ key, content }) {
    const storageKey = safeStorageKey(key);
    const fullPath = this.fullPath(storageKey);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    return { storageKey, size: content.length };
  }

  async readFile(key) {
    return fs.readFileSync(this.fullPath(key));
  }

  async listFiles(prefix = "") {
    const root = this.fullPath(prefix || ".");
    if (!fs.existsSync(root)) {
      return [];
    }

    const files = [];
    const storageRoot = this.root;
    function walk(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          files.push(path.relative(storageRoot, fullPath).replaceAll("\\", "/"));
        }
      }
    }
    walk(root);
    return files;
  }

  async deleteFile(key) {
    const fullPath = this.fullPath(key);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
    return { deleted: true };
  }

  async getDownloadUrl(key) {
    return `local://${safeStorageKey(key)}`;
  }
}

class SupabaseStorageProvider {
  constructor({ url, serviceRoleKey, bucket, fetchImpl = fetch } = {}) {
    this.id = "supabase";
    this.url = String(url || "").replace(/\/+$/, "");
    this.serviceRoleKey = serviceRoleKey || "";
    this.bucket = bucket || "";
    this.fetch = fetchImpl;
  }

  assertConfigured() {
    if (!this.url || !this.serviceRoleKey || !this.bucket) {
      throw new Error("Supabase storage requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_STORAGE_BUCKET.");
    }
  }

  objectUrl(key) {
    return `${this.url}/storage/v1/object/${encodeRfc3986(this.bucket)}/${safeStorageKey(key).split("/").map(encodeRfc3986).join("/")}`;
  }

  headers(extra = {}) {
    return {
      authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
      ...extra
    };
  }

  async uploadFile({ key, content, mimeType }) {
    this.assertConfigured();
    const response = await this.fetch(this.objectUrl(key), {
      method: "PUT",
      headers: this.headers({
        "content-type": mimeType || "application/octet-stream",
        "x-upsert": "true"
      }),
      body: content
    });
    if (!response.ok) {
      throw new Error(`Supabase upload failed: ${response.status} ${await response.text()}`);
    }
    return { storageKey: safeStorageKey(key), size: content.length };
  }

  async readFile(key) {
    this.assertConfigured();
    const response = await this.fetch(this.objectUrl(key), { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`Supabase read failed: ${response.status} ${await response.text()}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async listFiles(prefix = "") {
    this.assertConfigured();
    const response = await this.fetch(`${this.url}/storage/v1/object/list/${encodeRfc3986(this.bucket)}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ prefix })
    });
    if (!response.ok) {
      throw new Error(`Supabase list failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  async deleteFile(key) {
    this.assertConfigured();
    const response = await this.fetch(this.objectUrl(key), {
      method: "DELETE",
      headers: this.headers()
    });
    if (!response.ok) {
      throw new Error(`Supabase delete failed: ${response.status} ${await response.text()}`);
    }
    return { deleted: true };
  }

  async getDownloadUrl(key) {
    this.assertConfigured();
    return this.objectUrl(key);
  }
}

class S3StorageProvider {
  constructor({ endpoint, region = "auto", bucket, accessKeyId, secretAccessKey, fetchImpl = fetch } = {}) {
    this.id = "s3";
    this.endpoint = String(endpoint || "").replace(/\/+$/, "");
    this.region = region || "auto";
    this.bucket = bucket || "";
    this.accessKeyId = accessKeyId || "";
    this.secretAccessKey = secretAccessKey || "";
    this.fetch = fetchImpl;
  }

  assertConfigured() {
    if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.secretAccessKey) {
      throw new Error("S3 storage requires S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.");
    }
  }

  objectUrl(key) {
    return `${this.endpoint}/${encodeRfc3986(this.bucket)}/${safeStorageKey(key).split("/").map(encodeRfc3986).join("/")}`;
  }

  signedHeaders({ method, key, body = Buffer.alloc(0), contentType = "application/octet-stream" }) {
    const url = new URL(this.objectUrl(key));
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      method,
      url.pathname,
      url.searchParams.toString(),
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, dateStamp), this.region), "s3"), "aws4_request");
    const signature = hmac(signingKey, stringToSign, "hex");
    return {
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
  }

  async request(method, key, { body = Buffer.alloc(0), mimeType } = {}) {
    this.assertConfigured();
    const response = await this.fetch(this.objectUrl(key), {
      method,
      headers: this.signedHeaders({ method, key, body, contentType: mimeType || "application/octet-stream" }),
      body: method === "GET" || method === "DELETE" ? undefined : body
    });
    if (!response.ok) {
      throw new Error(`S3 ${method} failed: ${response.status} ${await response.text()}`);
    }
    return response;
  }

  async uploadFile({ key, content, mimeType }) {
    await this.request("PUT", key, { body: content, mimeType });
    return { storageKey: safeStorageKey(key), size: content.length };
  }

  async readFile(key) {
    const response = await this.request("GET", key);
    return Buffer.from(await response.arrayBuffer());
  }

  async listFiles() {
    this.assertConfigured();
    return [];
  }

  async deleteFile(key) {
    await this.request("DELETE", key);
    return { deleted: true };
  }

  async getDownloadUrl(key) {
    this.assertConfigured();
    return this.objectUrl(key);
  }
}

function createStorageProvider(config, options = {}) {
  if (config.provider === "supabase") {
    return new SupabaseStorageProvider({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
      bucket: config.supabaseBucket,
      fetchImpl: options.fetchImpl
    });
  }
  if (config.provider === "s3") {
    return new S3StorageProvider({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      bucket: config.s3Bucket,
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
      fetchImpl: options.fetchImpl
    });
  }
  return new LocalStorageProvider({ root: config.localPath });
}

module.exports = {
  LocalStorageProvider,
  S3StorageProvider,
  SupabaseStorageProvider,
  createStorageProvider,
  safeStorageKey
};
