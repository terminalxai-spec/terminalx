const permissions = [
  "tasks:create",
  "tasks:read",
  "tasks:update",
  "tasks:delete",
  "approvals:read",
  "approvals:approve",
  "files:upload",
  "files:read",
  "files:delete",
  "agents:execute",
  "chat:use",
  "settings:manage"
];

const rolePermissions = {
  admin: permissions,
  operator: [
    "tasks:create",
    "tasks:read",
    "approvals:read",
    "files:upload",
    "files:read",
    "agents:execute",
    "chat:use"
  ],
  viewer: ["tasks:read", "approvals:read", "files:read"]
};

function seedRbac(repository) {
  if (typeof repository.seedRolesAndPermissions === "function") {
    repository.seedRolesAndPermissions(rolePermissions);
    return;
  }

  for (const [role, rolePermissionList] of Object.entries(rolePermissions)) {
    repository.upsertRole({
      id: role,
      label: role[0].toUpperCase() + role.slice(1),
      description: `${role} role`
    });
    repository.setRolePermissions(role, rolePermissionList);
  }
}

function hasPermission(userPermissions, permissionName) {
  return Array.isArray(userPermissions) && userPermissions.includes(permissionName);
}

module.exports = {
  hasPermission,
  permissions,
  rolePermissions,
  seedRbac
};
