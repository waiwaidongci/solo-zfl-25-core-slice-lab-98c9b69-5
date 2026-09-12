// 岩矿实验室薄片制片流转系统
// 零依赖 Node.js 实现：内置 http 服务 + JSON 文件持久化（重启后数据保留）
import http from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3025);
const DB_FILE = process.env.DB_FILE || join(__dirname, "data", "lab-db.json");

// ---------- 业务常量 ----------
const ROLES = {
  admin: "管理员",
  registrar: "登记员",
  technician: "制样员",
  microscopist: "鉴定员",
  reviewer: "审核员",
};
// 制样规程：工序顺序固定，下一步由服务器裁定，客户端无法跳工序/回退
const STEP_DEFS = [
  { no: 1, name: "切片", role: "technician", slaHours: 24 },
  { no: 2, name: "粗磨", role: "technician", slaHours: 24 },
  { no: 3, name: "粘片", role: "technician", slaHours: 12 },
  { no: 4, name: "磨薄", role: "technician", slaHours: 24 },
  { no: 5, name: "盖片", role: "technician", slaHours: 12 },
  { no: 6, name: "镜下观察", role: "microscopist", slaHours: 48 },
];
const LAST_STEP = STEP_DEFS.length; // 6
// 各动作允许的角色（admin 为超级用户）
const ACL = {
  createBatch: ["registrar", "admin"],
  createSample: ["registrar", "admin"],
  batchEntry: ["registrar", "admin"],
  advance: ["technician", "admin"],
  observe: ["microscopist", "admin"],
  addDefect: ["admin", "registrar", "technician", "microscopist", "reviewer"],
  closeDefect: ["technician", "reviewer", "admin"],
  deliver: ["reviewer", "admin"],
  returnBatch: ["reviewer", "admin"],
  reinspect: ["reviewer", "admin"],
};

// ---------- 持久化 ----------
let db;
function blankDb() {
  return {
    meta: { batchSeq: 0, sampleSeq: 0, sectionSeq: 0, defectSeq: 0, eventSeq: 0 },
    users: [],
    sessions: {},
    batches: [],
    samples: [],
    sections: [],
    stepRecords: [],
    defects: [],
    events: [],
  };
}
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
}
function seedUsers() {
  const seeds = [
    ["admin", "admin123", "admin", "系统管理员"],
    ["reg1", "reg123", "registrar", "王登记"],
    ["tech1", "tech123", "technician", "李制样"],
    ["mic1", "mic123", "microscopist", "赵鉴定"],
    ["rev1", "rev123", "reviewer", "陈审核"],
  ];
  db.users = seeds.map(([username, pw, role, name], i) => {
    const salt = crypto.randomBytes(16).toString("hex");
    return { id: "U" + (i + 1), username, name, role, salt, passHash: hashPassword(pw, salt) };
  });
}
async function loadDb() {
  if (existsSync(DB_FILE)) {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
    // 清理过期会话
    const now = Date.now();
    for (const [k, s] of Object.entries(db.sessions)) if (s.expiresAt < now) delete db.sessions[k];
  } else {
    db = blankDb();
    seedUsers();
    await persist();
  }
}
let saveQueue = Promise.resolve();
function persist() {
  saveQueue = saveQueue.then(async () => {
    await mkdir(dirname(DB_FILE), { recursive: true });
    const tmp = DB_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, DB_FILE); // 原子替换，避免写一半损坏
  }).catch((e) => console.error("持久化失败:", e));
  return saveQueue;
}

// ---------- 工具 ----------
const nowIso = () => new Date().toISOString();
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function nonEmpty(v) { return typeof v === "string" && v.trim().length > 0; }
function trim(v) { return String(v ?? "").trim(); }

// ---------- 领域查询 ----------
const findBatch = (id) => db.batches.find((b) => b.id === id);
const findSample = (id) => db.samples.find((s) => s.id === id);
const findSection = (id) => db.sections.find((s) => s.id === id);
const findDefect = (id) => db.defects.find((d) => d.id === id);
const batchSections = (batchId) => db.sections.filter((s) => s.batchId === batchId);
const batchSamples = (batchId) => db.samples.filter((s) => s.batchId === batchId);
const sectionDefects = (sectionId) => db.defects.filter((d) => d.sectionId === sectionId);
const openDefects = (batchId) => db.defects.filter((d) => d.batchId === batchId && d.status === "未闭环");

function overdueInfo(section) {
  if (section.status !== "制片中") return null;
  const def = STEP_DEFS[section.currentStep - 1];
  if (!def) return null;
  const deadline = new Date(section.stepEnteredAt).getTime() + def.slaHours * 3600e3;
  const late = Date.now() - deadline;
  if (late <= 0) return null;
  return { hours: Math.floor(late / 3600e3), def };
}
function nextResponsibleOfSection(section) {
  if (section.status === "制片中") {
    const def = STEP_DEFS[section.currentStep - 1];
    return def ? `${ROLES[def.role]}（${def.name}）` : "—";
  }
  if (section.status === "待交付") return `${ROLES.reviewer}（交付）`;
  return "—";
}
function nextResponsibleOfBatch(batch) {
  if (batch.status === "已交付") return "—";
  if (batch.status === "已退回") return `${ROLES.reviewer}（复检）`;
  const sections = batchSections(batch.id);
  if (sections.length && sections.every((s) => s.status === "待交付") && !openDefects(batch.id).length)
    return `${ROLES.reviewer}（交付）`;
  const roles = [...new Set(sections.filter((s) => s.status === "制片中").map((s) => STEP_DEFS[s.currentStep - 1]?.role).filter(Boolean))];
  return roles.length ? roles.map((r) => ROLES[r]).join("、") : `${ROLES.reviewer}（交付）`;
}
// 交付门禁：薄片未走完 / 镜下结论为空 / 缺陷未闭环 / 状态非法 均禁止交付
function deliverBlockers(batch) {
  const errs = [];
  const sections = batchSections(batch.id);
  if (!sections.length) errs.push("批次内无薄片");
  if (batch.status === "已交付") errs.push("批次已交付，禁止重复交付");
  if (batch.status === "已退回") errs.push("批次已退回，须先完成复检");
  const unfinished = sections.filter((s) => s.status === "制片中");
  if (unfinished.length)
    errs.push("薄片未走完：" + unfinished.map((s) => `${s.code}(当前工序:${STEP_DEFS[s.currentStep - 1].name})`).join("、"));
  const noConclusion = sections.filter((s) => s.status !== "制片中" && !nonEmpty(s.conclusion));
  if (noConclusion.length) errs.push("镜下结论为空：" + noConclusion.map((s) => s.code).join("、"));
  const open = openDefects(batch.id);
  if (open.length) errs.push("缺陷未闭环：" + open.map((d) => `${d.sectionCode}(${d.desc})`).join("、"));
  return errs;
}
function logEvent(actor, action, entityType, entityId, entityLabel, batchId, detail, fromStatus, toStatus) {
  db.events.push({
    id: "EV" + ++db.meta.eventSeq,
    at: nowIso(),
    actor: actor.username,
    actorName: actor.name,
    role: actor.role,
    roleName: ROLES[actor.role],
    action, entityType, entityId, entityLabel, batchId: batchId || "",
    detail: detail || "", fromStatus: fromStatus || "", toStatus: toStatus || "",
  });
}

// ---------- 业务动作（同步校验+写入；Node 单线程保证并发下检查与写入原子） ----------
function createBatch(actor, { name, note }) {
  if (!nonEmpty(name)) return { error: "批次名称不能为空" };
  const batch = {
    id: "B" + ++db.meta.batchSeq,
    code: "PC-" + String(db.meta.batchSeq).padStart(3, "0"),
    name: trim(name), note: trim(note), status: "进行中",
    createdBy: actor.name, createdAt: nowIso(),
  };
  db.batches.push(batch);
  logEvent(actor, "建批次", "批次", batch.id, batch.code, batch.id, trim(note) || `建立批次 ${batch.name}`, "", "进行中");
  return { ok: batch };
}
function createSample(actor, batch, { rockType, note }) {
  if (batch.status === "已交付") return { error: "批次已交付，禁止新增样本" };
  if (!nonEmpty(rockType)) return { error: "岩性不能为空" };
  const sample = {
    id: "S" + ++db.meta.sampleSeq,
    code: "YP-" + String(db.meta.sampleSeq).padStart(3, "0"),
    batchId: batch.id, rockType: trim(rockType), note: trim(note),
    createdBy: actor.name, createdAt: nowIso(),
  };
  db.samples.push(sample);
  logEvent(actor, "建样本", "样本", sample.id, sample.code, batch.id, `岩性:${sample.rockType}`, "", "");
  return { ok: sample };
}
function batchEntry(actor, sample, { codesText, prefix, start, count }) {
  const batch = findBatch(sample.batchId);
  if (batch.status === "已交付") return { error: "批次已交付，禁止录入薄片" };
  let codes = [];
  if (nonEmpty(codesText)) {
    codes = codesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } else if (nonEmpty(prefix) && nonEmpty(count)) {
    const n = Number(count), s0 = Number(start || "1");
    if (!Number.isInteger(n) || n < 1 || n > 200) return { error: "数量须为 1-200 的整数" };
    if (!Number.isInteger(s0) || s0 < 0) return { error: "起始号须为非负整数" };
    const width = Math.max(2, String(s0 + n - 1).length);
    for (let i = 0; i < n; i++) codes.push(trim(prefix) + String(s0 + i).padStart(width, "0"));
  } else {
    return { error: "薄片编号不能为空：请逐行填写编号，或填写前缀+数量" };
  }
  const dup = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (dup.length) return { error: "本次录入编号重复：" + [...new Set(dup)].join("、") };
  const bad = codes.filter((c) => !/^[A-Za-z0-9][A-Za-z0-9-]{0,29}$/.test(c));
  if (bad.length) return { error: "编号格式非法（字母数字短横线，≤30位）：" + bad.join("、") };
  const exists = codes.filter((c) => db.sections.some((s) => s.code === c));
  if (exists.length) return { error: "编号已存在，禁止重复录入：" + exists.join("、") };
  const created = codes.map((code) => {
    const sec = {
      id: "SEC" + ++db.meta.sectionSeq, code, sampleId: sample.id, batchId: sample.batchId,
      status: "制片中", currentStep: 1, stepEnteredAt: nowIso(),
      conclusion: "", createdBy: actor.name, createdAt: nowIso(), deliveredAt: "",
    };
    db.sections.push(sec);
    return sec;
  });
  logEvent(actor, "批量录入", "样本", sample.id, sample.code, sample.batchId,
    `录入 ${created.length} 片：${codes.join("、")}`, "", "制片中");
  return { ok: created };
}
function advance(actor, section, { basis, stepNo }) {
  if (section.status === "已交付") return { error: "薄片已交付，禁止回退或重复操作" };
  if (section.status !== "制片中") return { error: `当前状态(${section.status})不允许推进，禁止重复提交` };
  if (section.currentStep > LAST_STEP - 1) return { error: "当前工序为镜下观察，请提交镜下观察结论" };
  if (!nonEmpty(basis)) return { error: "操作依据不能为空" };
  // 幂等防护：表单签发时的工序号必须与服务器当前工序一致，否则视为回退/跳工序/重复提交
  const expect = section.currentStep;
  if (String(stepNo ?? "") !== String(expect)) {
    if (Number(stepNo) < expect) return { error: "该工序已完成，禁止回退或重复提交，请刷新页面" };
    return { error: "工序状态已变化，禁止跳工序或重复提交，请刷新页面" };
  }
  if (db.stepRecords.some((r) => r.sectionId === section.id && r.stepNo === expect))
    return { error: "该工序已提交，禁止重复提交" };
  const def = STEP_DEFS[expect - 1];
  db.stepRecords.push({
    id: `SR-${section.id}-${expect}`, sectionId: section.id, stepNo: expect, stepName: def.name,
    operator: actor.username, operatorName: actor.name, role: actor.role, roleName: ROLES[actor.role],
    at: nowIso(), basis: trim(basis),
  });
  section.currentStep += 1;
  section.stepEnteredAt = nowIso();
  logEvent(actor, "工序推进", "薄片", section.id, section.code, section.batchId,
    `完成【${def.name}】依据:${trim(basis)}`, def.name, STEP_DEFS[section.currentStep - 1]?.name || "待交付");
  return { ok: section };
}
function observe(actor, section, { conclusion, basis }) {
  if (section.status === "已交付") return { error: "薄片已交付，禁止回退或重复操作" };
  if (section.status !== "制片中" || section.currentStep !== LAST_STEP)
    return { error: "尚未到镜下观察工序，禁止跳工序或重复提交" };
  if (!nonEmpty(conclusion)) return { error: "镜下结论不能为空" };
  if (!nonEmpty(basis)) return { error: "操作依据不能为空" };
  if (db.stepRecords.some((r) => r.sectionId === section.id && r.stepNo === LAST_STEP))
    return { error: "镜下观察已提交，禁止重复提交" };
  db.stepRecords.push({
    id: `SR-${section.id}-${LAST_STEP}`, sectionId: section.id, stepNo: LAST_STEP, stepName: "镜下观察",
    operator: actor.username, operatorName: actor.name, role: actor.role, roleName: ROLES[actor.role],
    at: nowIso(), basis: trim(basis),
  });
  section.conclusion = trim(conclusion);
  section.status = "待交付";
  section.currentStep = LAST_STEP + 1;
  section.stepEnteredAt = nowIso();
  logEvent(actor, "镜下观察", "薄片", section.id, section.code, section.batchId,
    `结论:${trim(conclusion)} 依据:${trim(basis)}`, "镜下观察", "待交付");
  return { ok: section };
}
function addDefect(actor, section, { desc }) {
  if (section.status === "已交付") return { error: "薄片已交付，禁止上报缺陷" };
  if (!nonEmpty(desc)) return { error: "缺陷描述不能为空" };
  const defect = {
    id: "DF" + ++db.meta.defectSeq, sectionId: section.id, sectionCode: section.code, batchId: section.batchId,
    desc: trim(desc), status: "未闭环", foundBy: actor.name, foundAt: nowIso(),
    closedBy: "", closedAt: "", closeNote: "",
  };
  db.defects.push(defect);
  logEvent(actor, "上报缺陷", "薄片", section.id, section.code, section.batchId, `缺陷:${trim(desc)}`, "", "未闭环");
  return { ok: defect };
}
function closeDefect(actor, defect, { note }) {
  if (defect.status === "已闭环") return { error: "缺陷已闭环，禁止重复提交" };
  if (!nonEmpty(note)) return { error: "闭环说明不能为空" };
  defect.status = "已闭环";
  defect.closedBy = actor.name;
  defect.closedAt = nowIso();
  defect.closeNote = trim(note);
  logEvent(actor, "闭环缺陷", "缺陷", defect.id, defect.sectionCode, defect.batchId, `闭环说明:${trim(note)}`, "未闭环", "已闭环");
  return { ok: defect };
}
function deliver(actor, batch, { basis }) {
  if (!nonEmpty(basis)) return { error: "交付依据不能为空" };
  const blockers = deliverBlockers(batch);
  if (blockers.length) return { error: "不满足交付条件：" + blockers.join("；") };
  const sections = batchSections(batch.id);
  batch.status = "已交付";
  batch.deliveredBy = actor.name;
  batch.deliveredAt = nowIso();
  for (const s of sections) { s.status = "已交付"; s.deliveredAt = nowIso(); }
  logEvent(actor, "交付", "批次", batch.id, batch.code, batch.id,
    `交付 ${sections.length} 片，依据:${trim(basis)}`, "进行中", "已交付");
  return { ok: batch };
}
function returnBatch(actor, batch, { reason }) {
  if (batch.status === "已交付") return { error: "批次已交付，禁止退回" };
  if (batch.status === "已退回") return { error: "批次已处于退回状态，禁止重复退回" };
  if (!nonEmpty(reason)) return { error: "退回原因不能为空" };
  batch.status = "已退回";
  logEvent(actor, "退回", "批次", batch.id, batch.code, batch.id, `退回原因:${trim(reason)}`, "进行中", "已退回");
  return { ok: batch };
}
function reinspect(actor, batch, { conclusion }) {
  if (batch.status !== "已退回") return { error: "仅退回状态的批次可复检" };
  if (!nonEmpty(conclusion)) return { error: "复检结论不能为空" };
  batch.status = "进行中";
  logEvent(actor, "复检", "批次", batch.id, batch.code, batch.id, `复检结论:${trim(conclusion)}`, "已退回", "进行中");
  return { ok: batch };
}

// ---------- HTTP 基础设施 ----------
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const sid = cookies(req).sid;
  const s = sid && db.sessions[sid];
  if (!s || s.expiresAt < Date.now()) return null;
  return db.users.find((u) => u.id === s.userId) || null;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) { req.destroy(); reject(new Error("请求体过大")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const type = String(req.headers["content-type"] || "");
      if (type.includes("application/json")) {
        try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
      } else {
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      }
    });
    req.on("error", reject);
  });
}
function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}
function backWith(path, key, msg) {
  return path + (path.includes("?") ? "&" : "?") + key + "=" + encodeURIComponent(msg);
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// ---------- 页面 ----------
function layout(user, title, content, query) {
  const err = query?.err ? `<div class="flash err">✗ ${esc(query.err)}</div>` : "";
  const ok = query?.ok ? `<div class="flash ok">✓ ${esc(query.ok)}</div>` : "";
  const nav = user
    ? `<nav>
        <a class="brand" href="/">薄片制片流转系统</a>
        <a href="/">批次列表</a>
        <a href="/events">留痕日志</a>
        <span class="spacer"></span>
        <span class="who">${esc(user.name)} · ${ROLES[user.role]}</span>
        <a href="/logout">退出</a>
      </nav>`
    : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - 薄片制片流转系统</title>
<style>
:root{--blue:#1a5fb4;--red:#c01c28;--bg:#f6f5f4}
*{box-sizing:border-box}body{margin:0;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:#241f31}
nav{display:flex;gap:16px;align-items:center;background:#1c1c28;padding:10px 20px}
nav a{color:#c0bfca;text-decoration:none;font-size:14px}nav a:hover{color:#fff}
nav .brand{color:#fff;font-weight:700;font-size:16px}
nav .spacer{flex:1}nav .who{color:#9a9996;font-size:13px}
main{max-width:1180px;margin:20px auto;padding:0 16px}
.card{background:#fff;border:1px solid #e0dee4;border-radius:8px;padding:16px 20px;margin-bottom:16px}
h1{font-size:20px;margin:6px 0 14px}h2{font-size:16px;margin:0 0 10px;color:#3d3846}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #e5e2ea;padding:6px 9px;text-align:left;vertical-align:top}
th{background:#f0eef4;white-space:nowrap}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:#e5e2ea;color:#3d3846;white-space:nowrap}
.badge.b-run{background:#dce8f9;color:#1a5fb4}.badge.b-ok{background:#d3f0e3;color:#177245}
.badge.b-ret{background:#fbe0c9;color:#a83e00}.badge.b-done{background:#e0e0e0;color:#5e5c64}
.badge.b-late{background:#f9d6dc;color:var(--red);font-weight:700}
.flash{padding:10px 14px;border-radius:6px;margin-bottom:14px;font-size:14px}
.flash.err{background:#f9d6dc;color:#8f1220}.flash.ok{background:#d3f0e3;color:#14532d}
input,textarea,select{font:inherit;padding:6px 8px;border:1px solid #c9c5d0;border-radius:5px;font-size:13px}
textarea{width:100%;min-height:64px}
button,.btn{font:inherit;background:var(--blue);color:#fff;border:0;border-radius:5px;padding:7px 14px;cursor:pointer;font-size:13px;text-decoration:none;display:inline-block}
button.gray,.btn.gray{background:#77767b}button.red{background:var(--red)}
form.inline{display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap}
form.block{display:flex;flex-direction:column;gap:8px;max-width:560px}
.muted{color:#5e5c64;font-size:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
ul.errs{margin:6px 0;padding-left:20px;color:#8f1220;font-size:13px}
.tag{font-size:12px;color:#5e5c64}
</style></head><body>${nav}<main>${err}${ok}${content}</main></body></html>`;
}
function statusBadge(s) {
  const cls = { 制片中: "b-run", 待交付: "b-ok", 已交付: "b-done", 已退回: "b-ret", 进行中: "b-run", 未闭环: "b-late", 已闭环: "b-ok" }[s] || "";
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}
function stepNameOf(section) {
  return section.status === "制片中" ? STEP_DEFS[section.currentStep - 1].name : "—";
}
function overdueBadge(section) {
  const o = overdueInfo(section);
  return o ? `<span class="badge b-late">逾期 ${o.hours}h</span>` : `<span class="tag">正常</span>`;
}

function loginPage(query) {
  return layout(null, "登录", `
  <div class="card" style="max-width:460px;margin:60px auto">
    <h1>岩矿实验室薄片制片流转系统</h1>
    <form class="block" method="post" action="/login">
      <label>账号 <input name="username" required autocomplete="username"></label>
      <label>密码 <input name="password" type="password" required autocomplete="current-password"></label>
      <button>登录</button>
    </form>
    <p class="muted">演示账号（角色）：admin/admin123（管理员）、reg1/reg123（登记员）、tech1/tech123（制样员）、mic1/mic123（鉴定员）、rev1/rev123（审核员）</p>
  </div>`, query);
}

function dashboardPage(user, query) {
  const rows = db.batches.map((b) => {
    const sections = batchSections(b.id);
    const done = sections.filter((s) => s.status !== "制片中").length;
    const late = sections.filter((s) => overdueInfo(s)).length;
    return `<tr>
      <td><a href="/batches/${b.id}">${esc(b.code)}</a></td>
      <td>${esc(b.name)}</td>
      <td>${statusBadge(b.status)}</td>
      <td>${done}/${sections.length}</td>
      <td>${late ? `<span class="badge b-late">逾期 ${late} 项</span>` : "无"}</td>
      <td>${esc(nextResponsibleOfBatch(b))}</td>
      <td class="muted">${esc(b.createdBy)}<br>${fmt(b.createdAt)}</td>
    </tr>`;
  }).join("");
  const newBtn = ACL.createBatch.includes(user.role) ? `<a class="btn" href="/batches/new">+ 新建批次</a>` : "";
  return layout(user, "批次列表", `
    <h1>批次列表 ${newBtn}</h1>
    <div class="card"><table>
      <tr><th>批次编号</th><th>名称</th><th>状态</th><th>完成/总数</th><th>逾期项</th><th>下一步负责人</th><th>创建</th></tr>
      ${rows || `<tr><td colspan="7" class="muted">暂无批次</td></tr>`}
    </table></div>`, query);
}

function newBatchPage(user, query) {
  return layout(user, "新建批次", `
    <h1>新建批次</h1>
    <div class="card"><form class="block" method="post" action="/batches">
      <label>批次名称 * <input name="name" required></label>
      <label>备注 <input name="note"></label>
      <button>建立批次</button>
    </form></div>`, query);
}

function batchPage(user, batch, query) {
  const sections = batchSections(batch.id);
  const samples = batchSamples(batch.id);
  const blockers = deliverBlockers(batch);
  const gate = blockers.length
    ? `<ul class="errs">${blockers.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`
    : `<p style="color:#177245">✓ 满足交付条件（薄片全部走完、镜下结论齐全、缺陷全部闭环）</p>`;

  // 批次级操作：交付 / 退回 / 复检（均留痕）
  let actions = "";
  if (batch.status !== "已交付" && ACL.deliver.includes(user.role)) {
    actions += `<form class="inline" method="post" action="/batches/${batch.id}/deliver">
      <input name="basis" placeholder="交付依据（如委托单号）" required>
      <button>交付本批次</button></form>`;
  }
  if (batch.status === "进行中" && ACL.returnBatch.includes(user.role)) {
    actions += `<form class="inline" method="post" action="/batches/${batch.id}/return">
      <input name="reason" placeholder="退回原因" required>
      <button class="red">退回本批次</button></form>`;
  }
  if (batch.status === "已退回" && ACL.reinspect.includes(user.role)) {
    actions += `<form class="inline" method="post" action="/batches/${batch.id}/reinspect">
      <input name="conclusion" placeholder="复检结论" required>
      <button>提交复检</button></form>`;
  }
  if (!actions) actions = `<span class="muted">当前角色无批次级操作权限或批次已交付</span>`;

  // 样本与批量录入
  let sampleBlock = "";
  if (ACL.createSample.includes(user.role) && batch.status !== "已交付") {
    sampleBlock += `<div class="card"><h2>添加样本</h2>
      <form class="inline" method="post" action="/batches/${batch.id}/samples">
        <input name="rockType" placeholder="岩性（如花岗闪长岩）" required>
        <input name="note" placeholder="备注">
        <button>添加样本</button>
      </form></div>`;
  }
  for (const smp of samples) {
    const entryForm = ACL.batchEntry.includes(user.role) && batch.status !== "已交付"
      ? `<form class="block" method="post" action="/samples/${smp.id}/sections" style="max-width:none">
          <div class="grid">
            <label>逐行编号（每行一个）<textarea name="codesText" placeholder="DL-08&#10;DL-09"></textarea></label>
            <div class="block">或按规则生成：
              <span class="inline"><input name="prefix" placeholder="前缀 如 DL-" size="8">
              <input name="start" placeholder="起始号" size="5" value="1">
              <input name="count" placeholder="数量" size="5"></span>
              <button>批量录入薄片</button>
            </div>
          </div>
        </form>` : "";
    sampleBlock += `<div class="card"><h2>样本 ${esc(smp.code)} · ${esc(smp.rockType)}
        <span class="muted">${esc(smp.createdBy)} 建于 ${fmt(smp.createdAt)}</span></h2>${entryForm}</div>`;
  }

  const secRows = sections.map((s) => {
    const smp = findSample(s.sampleId);
    const open = sectionDefects(s.id).filter((d) => d.status === "未闭环").length;
    return `<tr>
      <td><a href="/sections/${s.id}">${esc(s.code)}</a></td>
      <td>${esc(smp?.code || "")}</td>
      <td>${statusBadge(s.status)}</td>
      <td>${esc(stepNameOf(s))}</td>
      <td>${overdueBadge(s)}</td>
      <td>${esc(nextResponsibleOfSection(s))}</td>
      <td>${s.conclusion ? esc(s.conclusion) : '<span class="muted">（空）</span>'}</td>
      <td>${open ? `<span class="badge b-late">${open} 项未闭环</span>` : "—"}</td>
    </tr>`;
  }).join("");

  const evRows = db.events.filter((e) => e.batchId === batch.id).slice(-30).reverse().map((e) => `
    <tr><td class="muted">${fmt(e.at)}</td><td>${esc(e.actorName)}（${esc(e.roleName)}）</td>
    <td>${esc(e.action)}</td><td>${esc(e.entityLabel)}</td><td>${esc(e.detail)}</td>
    <td>${e.fromStatus ? esc(e.fromStatus) + " → " + esc(e.toStatus) : "—"}</td></tr>`).join("");

  return layout(user, `批次 ${batch.code}`, `
    <h1>批次 ${esc(batch.code)} · ${esc(batch.name)} ${statusBadge(batch.status)}</h1>
    <div class="card"><h2>交付检查</h2>${gate}
      <h2 style="margin-top:12px">批次操作（交付 / 退回 / 复检均留痕）</h2>
      <div style="display:flex;gap:18px;flex-wrap:wrap">${actions}</div>
      <p class="muted">创建：${esc(batch.createdBy)} ${fmt(batch.createdAt)}${batch.deliveredAt ? `　交付：${esc(batch.deliveredBy)} ${fmt(batch.deliveredAt)}` : ""}</p>
    </div>
    ${sampleBlock}
    <div class="card"><h2>薄片清单（当前工序 / 逾期 / 下一步负责人）</h2>
      <table><tr><th>薄片编号</th><th>样本</th><th>状态</th><th>当前工序</th><th>逾期</th><th>下一步负责人</th><th>镜下结论</th><th>缺陷</th></tr>
      ${secRows || `<tr><td colspan="8" class="muted">暂无薄片</td></tr>`}</table></div>
    <div class="card"><h2>本批次留痕（最近 30 条）</h2>
      <table><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>依据/说明</th><th>状态变化</th></tr>
      ${evRows || `<tr><td colspan="6" class="muted">暂无记录</td></tr>`}</table></div>`, query);
}

function sectionPage(user, section, query) {
  const batch = findBatch(section.batchId);
  const sample = findSample(section.sampleId);
  const records = db.stepRecords.filter((r) => r.sectionId === section.id);
  const defects = sectionDefects(section.id);

  let actionHtml = "";
  if (section.status === "制片中" && section.currentStep <= LAST_STEP - 1 && ACL.advance.includes(user.role)) {
    const def = STEP_DEFS[section.currentStep - 1];
    actionHtml += `<div class="card"><h2>工序推进（当前：${esc(def.name)}，要求角色：${ROLES[def.role]}）</h2>
      <form class="inline" method="post" action="/sections/${section.id}/advance">
        <input type="hidden" name="stepNo" value="${section.currentStep}">
        <input name="basis" placeholder="操作依据（规程条款/记录编号）" required size="40">
        <button>完成【${esc(def.name)}】并推进</button>
      </form></div>`;
  }
  if (section.status === "制片中" && section.currentStep === LAST_STEP && ACL.observe.includes(user.role)) {
    actionHtml += `<div class="card"><h2>镜下观察（要求角色：${ROLES.microscopist}）</h2>
      <form class="block" method="post" action="/sections/${section.id}/observe">
        <label>镜下结论 * <textarea name="conclusion" required placeholder="矿物组成、结构构造、蚀变矿化等"></textarea></label>
        <label>操作依据 * <input name="basis" required placeholder="鉴定规程条款"></label>
        <button>提交镜下观察</button>
      </form></div>`;
  }
  if (section.status !== "已交付") {
    actionHtml += `<div class="card"><h2>上报缺陷</h2>
      <form class="inline" method="post" action="/sections/${section.id}/defects">
        <input name="desc" placeholder="缺陷描述（如崩边、厚度超标）" required size="40">
        <button class="gray">上报缺陷</button>
      </form></div>`;
  }

  const recRows = records.map((r) => `
    <tr><td>${r.stepNo}. ${esc(r.stepName)}</td><td>${esc(r.operatorName)}（${esc(r.roleName)}）</td>
    <td>${fmt(r.at)}</td><td>${esc(r.basis)}</td></tr>`).join("");

  const defRows = defects.map((d) => `
    <tr><td>${statusBadge(d.status)}</td><td>${esc(d.desc)}</td>
    <td>${esc(d.foundBy)}<br><span class="muted">${fmt(d.foundAt)}</span></td>
    <td>${d.status === "已闭环" ? `${esc(d.closedBy)}<br><span class="muted">${fmt(d.closedAt)}</span><br>${esc(d.closeNote)}` : "—"}</td>
    <td>${d.status === "未闭环" && ACL.closeDefect.includes(user.role)
      ? `<form class="inline" method="post" action="/defects/${d.id}/close">
          <input name="note" placeholder="闭环说明" required><button>闭环</button></form>` : ""}</td></tr>`).join("");

  const evRows = db.events.filter((e) => e.entityId === section.id || (e.entityType === "缺陷" && defects.some((d) => d.id === e.entityId)))
    .slice(-20).reverse().map((e) => `
    <tr><td class="muted">${fmt(e.at)}</td><td>${esc(e.actorName)}（${esc(e.roleName)}）</td>
    <td>${esc(e.action)}</td><td>${esc(e.detail)}</td></tr>`).join("");

  return layout(user, `薄片 ${section.code}`, `
    <h1>薄片 ${esc(section.code)} ${statusBadge(section.status)} ${overdueBadge(section)}</h1>
    <div class="card"><table>
      <tr><th>所属批次</th><td><a href="/batches/${batch.id}">${esc(batch.code)} ${esc(batch.name)}</a></td>
          <th>所属样本</th><td>${esc(sample?.code)}（${esc(sample?.rockType)}）</td></tr>
      <tr><th>当前工序</th><td>${esc(stepNameOf(section))}</td><th>下一步负责人</th><td>${esc(nextResponsibleOfSection(section))}</td></tr>
      <tr><th>本工序进入时间</th><td>${fmt(section.stepEnteredAt)}</td><th>镜下结论</th><td>${section.conclusion ? esc(section.conclusion) : '<span class="muted">（空）</span>'}</td></tr>
    </table></div>
    ${actionHtml}
    <div class="card"><h2>工序记录（操作人 / 时间 / 依据）</h2>
      <table><tr><th>工序</th><th>操作人</th><th>时间</th><th>依据</th></tr>
      ${recRows || `<tr><td colspan="4" class="muted">暂无</td></tr>`}</table></div>
    <div class="card"><h2>缺陷（未闭环将阻止交付）</h2>
      <table><tr><th>状态</th><th>描述</th><th>上报</th><th>闭环</th><th>操作</th></tr>
      ${defRows || `<tr><td colspan="5" class="muted">无缺陷</td></tr>`}</table></div>
    <div class="card"><h2>留痕</h2>
      <table><tr><th>时间</th><th>操作人</th><th>动作</th><th>依据/说明</th></tr>
      ${evRows || `<tr><td colspan="4" class="muted">暂无</td></tr>`}</table></div>`, query);
}

function eventsPage(user, query) {
  const rows = db.events.slice(-200).reverse().map((e) => `
    <tr><td class="muted">${fmt(e.at)}</td><td>${esc(e.actorName)}（${esc(e.roleName)}）</td>
    <td>${esc(e.action)}</td><td>${esc(e.entityType)} ${esc(e.entityLabel)}</td>
    <td>${esc(e.detail)}</td><td>${e.fromStatus ? esc(e.fromStatus) + " → " + esc(e.toStatus) : "—"}</td></tr>`).join("");
  return layout(user, "留痕日志", `
    <h1>留痕日志（最近 200 条）</h1>
    <div class="card"><table><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>依据/说明</th><th>状态变化</th></tr>
    ${rows || `<tr><td colspan="6" class="muted">暂无</td></tr>`}</table></div>`, query);
}

function errorPage(user, status, msg) {
  return layout(user, String(status), `<div class="card"><h1>${status}</h1><p>${esc(msg)}</p><p><a href="/">返回批次列表</a></p></div>`, {});
}

// ---------- 路由 ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp("^" + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$");
  routes.push({ method, rx, keys, handler, isPublic: !!opts.public });
}
const permit = (user, action) => user && ACL[action].includes(user.role);

// 页面
route("GET", "/login", async (req, res, p, user, q) => {
  if (user) return redirect(res, "/");
  sendHtml(res, 200, loginPage(q));
}, { public: true });
route("GET", "/", async (req, res, p, user, q) => sendHtml(res, 200, dashboardPage(user, q)));
route("GET", "/batches/new", async (req, res, p, user, q) => {
  if (!permit(user, "createBatch")) return sendHtml(res, 403, errorPage(user, 403, "越权：仅登记员可新建批次"));
  sendHtml(res, 200, newBatchPage(user, q));
});
route("GET", "/batches/:id", async (req, res, p, user, q) => {
  const batch = findBatch(p.id);
  if (!batch) return sendHtml(res, 404, errorPage(user, 404, "批次不存在"));
  sendHtml(res, 200, batchPage(user, batch, q));
});
route("GET", "/sections/:id", async (req, res, p, user, q) => {
  const section = findSection(p.id);
  if (!section) return sendHtml(res, 404, errorPage(user, 404, "薄片不存在"));
  sendHtml(res, 200, sectionPage(user, section, q));
});
route("GET", "/events", async (req, res, p, user, q) => sendHtml(res, 200, eventsPage(user, q)));
route("GET", "/logout", async (req, res) => {
  const sid = cookies(req).sid;
  if (sid) delete db.sessions[sid];
  await persist();
  res.writeHead(303, { Location: "/login", "Set-Cookie": "sid=; Path=/; HttpOnly; Max-Age=0" });
  res.end();
});
// 只读 JSON（供核对与自动化验证）
route("GET", "/api/batches/:id", async (req, res, p) => {
  const batch = findBatch(p.id);
  if (!batch) return sendJson(res, 404, { error: "批次不存在" });
  sendJson(res, 200, {
    batch,
    samples: batchSamples(batch.id),
    sections: batchSections(batch.id),
    defects: db.defects.filter((d) => d.batchId === batch.id),
    events: db.events.filter((e) => e.batchId === batch.id),
    deliverBlockers: deliverBlockers(batch),
  });
});

// 认证
route("POST", "/login", async (req, res, p, user, q, body) => {
  const u = db.users.find((x) => x.username === trim(body.username));
  const hash = u ? hashPassword(String(body.password || ""), u.salt) : "";
  if (!u || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.passHash)))
    return redirect(res, backWith("/login", "err", "账号或密码错误"));
  const sid = crypto.randomBytes(24).toString("hex");
  db.sessions[sid] = { userId: u.id, createdAt: Date.now(), expiresAt: Date.now() + 7 * 86400e3 };
  await persist();
  res.writeHead(303, { Location: "/", "Set-Cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
  res.end();
}, { public: true });

// 业务 POST：统一“校验角色 → 执行业务动作 → 持久化 → 303 回跳”
function postAction(pattern, action, run) {
  route("POST", pattern, async (req, res, p, user, q, body) => {
    if (!permit(user, action)) return sendHtml(res, 403, errorPage(user, 403, `越权：该操作需要角色 ${ACL[action].map((r) => ROLES[r]).join("/")}`));
    const result = run(user, p, body);
    if (result.error) return redirect(res, backWith(result.back, "err", result.error));
    await persist();
    redirect(res, backWith(result.back, "ok", result.message || "操作成功"));
  });
}
postAction("/batches", "createBatch", (user, p, body) => {
  const r = createBatch(user, body);
  if (r.error) return { error: r.error, back: "/batches/new" };
  return { back: `/batches/${r.ok.id}`, message: `批次 ${r.ok.code} 已建立` };
});
postAction("/batches/:id/samples", "createSample", (user, p, body) => {
  const batch = findBatch(p.id);
  if (!batch) return { error: "批次不存在", back: "/" };
  const r = createSample(user, batch, body);
  if (r.error) return { error: r.error, back: `/batches/${batch.id}` };
  return { back: `/batches/${batch.id}`, message: `样本 ${r.ok.code} 已建立` };
});
postAction("/samples/:id/sections", "batchEntry", (user, p, body) => {
  const sample = findSample(p.id);
  if (!sample) return { error: "样本不存在", back: "/" };
  const r = batchEntry(user, sample, body);
  if (r.error) return { error: r.error, back: `/batches/${sample.batchId}` };
  return { back: `/batches/${sample.batchId}`, message: `已录入 ${r.ok.length} 片` };
});
postAction("/sections/:id/advance", "advance", (user, p, body) => {
  const section = findSection(p.id);
  if (!section) return { error: "薄片不存在", back: "/" };
  const r = advance(user, section, body);
  if (r.error) return { error: r.error, back: `/sections/${section.id}` };
  return { back: `/sections/${section.id}`, message: `已推进至【${stepNameOf(section)}】` };
});
postAction("/sections/:id/observe", "observe", (user, p, body) => {
  const section = findSection(p.id);
  if (!section) return { error: "薄片不存在", back: "/" };
  const r = observe(user, section, body);
  if (r.error) return { error: r.error, back: `/sections/${section.id}` };
  return { back: `/sections/${section.id}`, message: "镜下观察已提交，薄片待交付" };
});
postAction("/sections/:id/defects", "addDefect", (user, p, body) => {
  const section = findSection(p.id);
  if (!section) return { error: "薄片不存在", back: "/" };
  const r = addDefect(user, section, body);
  if (r.error) return { error: r.error, back: `/sections/${section.id}` };
  return { back: `/sections/${section.id}`, message: "缺陷已上报" };
});
postAction("/defects/:id/close", "closeDefect", (user, p, body) => {
  const defect = findDefect(p.id);
  if (!defect) return { error: "缺陷不存在", back: "/" };
  const r = closeDefect(user, defect, body);
  if (r.error) return { error: r.error, back: `/sections/${defect.sectionId}` };
  return { back: `/sections/${defect.sectionId}`, message: "缺陷已闭环" };
});
postAction("/batches/:id/deliver", "deliver", (user, p, body) => {
  const batch = findBatch(p.id);
  if (!batch) return { error: "批次不存在", back: "/" };
  const r = deliver(user, batch, body);
  if (r.error) return { error: r.error, back: `/batches/${batch.id}` };
  return { back: `/batches/${batch.id}`, message: `批次 ${batch.code} 已交付` };
});
postAction("/batches/:id/return", "returnBatch", (user, p, body) => {
  const batch = findBatch(p.id);
  if (!batch) return { error: "批次不存在", back: "/" };
  const r = returnBatch(user, batch, body);
  if (r.error) return { error: r.error, back: `/batches/${batch.id}` };
  return { back: `/batches/${batch.id}`, message: `批次 ${batch.code} 已退回` };
});
postAction("/batches/:id/reinspect", "reinspect", (user, p, body) => {
  const batch = findBatch(p.id);
  if (!batch) return { error: "批次不存在", back: "/" };
  const r = reinspect(user, batch, body);
  if (r.error) return { error: r.error, back: `/batches/${batch.id}` };
  return { back: `/batches/${batch.id}`, message: `批次 ${batch.code} 复检完成，回到进行中` };
});

// ---------- 服务 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const query = Object.fromEntries(url.searchParams);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const user = currentUser(req);
      if (!user && !r.isPublic) return redirect(res, "/login");
      const body = req.method === "POST" ? await readBody(req) : {};
      return await r.handler(req, res, params, user, query, body);
    }
    sendHtml(res, 404, errorPage(currentUser(req), 404, "页面不存在"));
  } catch (e) {
    console.error(e);
    try { sendHtml(res, 500, errorPage(currentUser(req), 500, "服务器内部错误")); } catch { res.end(); }
  }
});

await loadDb();
server.listen(PORT, () => console.log(`薄片制片流转系统已启动: http://127.0.0.1:${PORT}  (数据文件: ${DB_FILE})`));
