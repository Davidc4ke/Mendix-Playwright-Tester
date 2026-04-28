/**
 * Single-tenant user management for the standalone cloud server.
 *
 * Users are stored in DATA_DIR/users.json (separate from scenarios.json).
 * On first boot, an admin account is auto-created from:
 *   ADMIN_USERNAME  — defaults to "admin"
 *   ADMIN_PASSWORD  — required; if missing, password login is unavailable
 *
 * Passwords are hashed with bcryptjs (cost 12).
 */

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { getPaths } = require("./paths");

function usersPath() {
  return path.join(getPaths().DATA_DIR, "users.json");
}

function loadUsers() {
  const p = usersPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(usersPath(), JSON.stringify(users, null, 2));
}

async function ensureAdminUser() {
  const users = loadUsers();
  if (users.length > 0) return; // already initialised

  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.warn(
      "[auth] No users exist and ADMIN_PASSWORD is not set — " +
      "username/password login will be unavailable until ADMIN_PASSWORD is configured."
    );
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  users.push({
    id: uuidv4(),
    username,
    passwordHash,
    role: "admin",
    createdAt: new Date().toISOString(),
  });
  saveUsers(users);
  console.log(`[auth] Admin user created: ${username}`);
}

async function verifyPassword(username, password) {
  const user = loadUsers().find((u) => u.username === username);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? { id: user.id, username: user.username, role: user.role } : null;
}

function findById(id) {
  return loadUsers().find((u) => u.id === id) || null;
}

module.exports = { loadUsers, saveUsers, ensureAdminUser, verifyPassword, findById };
