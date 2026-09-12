// 端到端验证：登录、建档、批量录入、推进、观察、交付、退回复检
// 以及空值、越权、并发重复、非法状态、重启恢复、逾期显示
// 运行：node test-flow.mjs
import { spawn } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/thin-test-db.json";

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  let cookie = "";
  return {
    async req(method, path, body) {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      let payload;
      if (body !== undefined) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        payload = new URLSearchParams(body).toString();
      }
      const res = await fetch(BASE + path, { method, headers, body: payload, redirect: "manual" });
      const setc = res.headers.get("set-cookie");
      if (setc) cookie = setc.split(";")[0];
      const text = await res.text();
      return { status: res.status, text, location: res.headers.get("location") || "" };
    },
    get(p) { return this.req("GET", p); },
    post(p, b) { return this.req("POST", p, b ?? {}); },
    async api(batchId) {
      const r = await this.get(`/api/batches/${batchId}`);
      return JSON.parse(r.text);
    },
  };
}
const ok = (r) => r.status === 303 && !r.location.includes("err=");
const errWith = (r, kw) => r.status === 303 && decodeURIComponent(r.location).includes(kw);

async function startServer() {
  const child = spawn("node", ["server.js"], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: DB },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/login"); if (r.status === 200) return child; } catch {}
    await sleep(100);
  }
  throw new Error("服务器启动超时");
}
async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((r) => { child.on("exit", r); setTimeout(r, 3000); });
}

// 把某薄片全部工序走完（制样员推进 1-5，鉴定员观察 6）
async function finishSection(tech, mic, secId, tag) {
  for (let s = 1; s <= 5; s++) {
    const r = await tech.post(`/sections/${secId}/advance`, { basis: `规程Q/YS-008 ${tag}`, stepNo: String(s) });
    if (!ok(r)) throw new Error(`推进失败 ${secId} 工序${s}: ${r.location}`);
  }
  const r = await mic.post(`/sections/${secId}/observe`, { conclusion: `镜下结论-${tag}`, basis: "鉴定规程DZ/T 0275" });
  if (!ok(r)) throw new Error(`观察失败 ${secId}: ${r.location}`);
}

async function main() {
  await rm(DB, { force: true });
  let srv = await startServer();
  console.log("== 阶段A：登录与权限 ==");
  const anon = client(), admin = client(), reg = client(), tech = client(), mic = client(), rev = client();

  let r = await anon.get("/");
  check("未登录访问首页 → 重定向登录页", r.status === 303 && r.location === "/login");
  r = await anon.get("/login");
  check("登录页可访问", r.status === 200 && r.text.includes("登录"));
  r = await admin.post("/login", { username: "admin", password: "wrong" });
  check("错误密码拒绝登录", errWith(r, "账号或密码错误"));
  for (const [c, u, p] of [[admin, "admin", "admin123"], [reg, "reg1", "reg123"], [tech, "tech1", "tech123"], [mic, "mic1", "mic123"], [rev, "rev1", "rev123"]]) {
    r = await c.post("/login", { username: u, password: p });
    check(`登录 ${u}`, r.status === 303 && r.location === "/");
  }

  console.log("== 阶段B：建档与批量录入 ==");
  r = await tech.post("/batches", { name: "越权批次" });
  check("制样员建批次 → 403 越权", r.status === 403 && r.text.includes("越权"));
  r = await reg.post("/batches", { name: "  " });
  check("批次名称为空 → 拒绝", errWith(r, "批次名称不能为空"));
  r = await reg.post("/batches", { name: "东岭铜矿一批", note: "ZK-17" });
  check("登记员建批次", ok(r));
  const b1 = r.location.match(/\/batches\/(\w+)/)[1];

  r = await reg.post(`/batches/${b1}/samples`, { rockType: "" });
  check("岩性为空 → 拒绝", errWith(r, "岩性不能为空"));
  r = await reg.post(`/batches/${b1}/samples`, { rockType: "花岗闪长岩" });
  check("建样本", ok(r));
  let api = await reg.api(b1);
  const s1 = api.samples[0].id;

  r = await reg.post(`/samples/${s1}/sections`, { codesText: "", prefix: "", count: "" });
  check("薄片编号为空 → 拒绝", errWith(r, "不能为空"));
  r = await reg.post(`/samples/${s1}/sections`, { prefix: "DL-", start: "1", count: "5" });
  check("批量录入（前缀+数量）5 片", ok(r));
  r = await reg.post(`/samples/${s1}/sections`, { prefix: "DL-", start: "1", count: "5" });
  check("重复录入同编号 → 拒绝", errWith(r, "禁止重复录入"));
  r = await reg.post(`/samples/${s1}/sections`, { codesText: "DL-06\nDL-07\nDL-07" });
  check("同批编号重复 → 拒绝", errWith(r, "编号重复"));
  r = await reg.post(`/samples/${s1}/sections`, { codesText: "DL 08" });
  check("编号含空格 → 拒绝", errWith(r, "格式非法"));
  r = await reg.post(`/samples/${s1}/sections`, { codesText: "DL-06\nDL-07" });
  check("批量录入（逐行）2 片", ok(r));
  api = await reg.api(b1);
  check("批次共 7 片", api.sections.length === 7);
  const secs = Object.fromEntries(api.sections.map((s) => [s.code, s]));
  check("新片初始化工序=切片", api.sections.every((s) => s.currentStep === 1 && s.status === "制片中"));

  console.log("== 阶段C：工序推进与防护 ==");
  const sec1 = secs["DL-01"].id;
  r = await mic.post(`/sections/${sec1}/advance`, { basis: "x" });
  check("鉴定员做制片工序 → 403 越权", r.status === 403);
  r = await reg.post(`/sections/${sec1}/advance`, { basis: "x" });
  check("登记员推进工序 → 403 越权", r.status === 403);
  r = await tech.post(`/sections/${sec1}/advance`, { basis: " " });
  check("依据为空 → 拒绝", errWith(r, "依据不能为空"));
  r = await tech.post(`/sections/${sec1}/advance`, { basis: "Q/YS-008 切片", stepNo: "1" });
  check("制样员完成工序1", ok(r));

  // 并发重复提交：同一薄片同一工序（表单签发的 stepNo=2）同时提交两次
  const [c1, c2] = await Promise.all([
    tech.post(`/sections/${sec1}/advance`, { basis: "并发A", stepNo: "2" }),
    tech.post(`/sections/${sec1}/advance`, { basis: "并发B", stepNo: "2" }),
  ]);
  const wins = [c1, c2].filter(ok).length, loses = [c1, c2].filter((x) => errWith(x, "重复提交")).length;
  check("并发重复提交：恰好一次成功一次拒绝", wins === 1 && loses === 1, `wins=${wins} loses=${loses}`);
  api = await reg.api(b1);
  check("并发后只推进到工序3", api.sections.find((s) => s.code === "DL-01").currentStep === 3);

  // 回退与跳工序防护：工序号由服务器裁定，伪造一律拒绝
  r = await tech.post(`/sections/${sec1}/advance`, { basis: "回退", stepNo: "1" });
  check("提交已完成工序号 → 禁止回退", errWith(r, "禁止回退或重复提交"));
  r = await tech.post(`/sections/${sec1}/advance`, { basis: "跳工序", stepNo: "5" });
  check("提交未来工序号 → 禁止跳工序", errWith(r, "禁止跳工序"));
  api = await reg.api(b1);
  check("伪造工序号后状态未变", api.sections.find((s) => s.code === "DL-01").currentStep === 3);
  r = await tech.post(`/sections/${sec1}/advance`, { basis: "工序3", stepNo: "3" });
  r = await tech.post(`/sections/${sec1}/advance`, { basis: "工序4", stepNo: "4" });
  r = await tech.post(`/sections/${sec1}/advance`, { basis: "工序5", stepNo: "5" });
  api = await reg.api(b1);
  check("按规程推进到镜下观察", ok(r) && api.sections.find((s) => s.code === "DL-01").currentStep === 6);

  // 用尚在工序1的 DL-02 验证"未到镜检就提交观察"
  r = await mic.post(`/sections/${secs["DL-02"].id}/observe`, { conclusion: "x", basis: "y" });
  check("未到镜检工序提交观察 → 禁止跳工序", errWith(r, "禁止跳工序"));
  r = await tech.post(`/sections/${sec1}/observe`, { conclusion: "x", basis: "y" });
  check("制样员做镜下观察 → 403 越权", r.status === 403);
  r = await mic.post(`/sections/${sec1}/observe`, { conclusion: "", basis: "y" });
  check("镜下结论为空 → 拒绝", errWith(r, "镜下结论不能为空"));
  r = await mic.post(`/sections/${sec1}/observe`, { conclusion: "含黄铜矿，他形粒状", basis: "DZ/T 0275" });
  check("鉴定员提交镜下观察", ok(r));
  r = await mic.post(`/sections/${sec1}/observe`, { conclusion: "重复", basis: "x" });
  check("重复提交镜下观察 → 拒绝", errWith(r, "禁止跳工序或重复提交"));
  api = await reg.api(b1);
  check("DL-01 状态=待交付", api.sections.find((s) => s.code === "DL-01").status === "待交付");

  console.log("== 阶段D：交付门禁与缺陷闭环 ==");
  r = await tech.post(`/batches/${b1}/deliver`, { basis: "x" });
  check("制样员交付 → 403 越权", r.status === 403);
  r = await rev.post(`/batches/${b1}/deliver`, { basis: "" });
  check("交付依据为空 → 拒绝", errWith(r, "交付依据不能为空"));
  r = await rev.post(`/batches/${b1}/deliver`, { basis: "WT-2026-011" });
  check("薄片未走完 → 禁止交付", errWith(r, "薄片未走完"));

  for (const code of ["DL-02", "DL-03", "DL-04", "DL-05", "DL-06", "DL-07"])
    await finishSection(tech, mic, secs[code].id, code);

  r = await tech.post(`/sections/${secs["DL-02"].id}/defects`, { desc: "" });
  check("缺陷描述为空 → 拒绝", errWith(r, "缺陷描述不能为空"));
  r = await tech.post(`/sections/${secs["DL-02"].id}/defects`, { desc: "边缘崩缺" });
  check("上报缺陷", ok(r));
  r = await rev.post(`/batches/${b1}/deliver`, { basis: "WT-2026-011" });
  check("缺陷未闭环 → 禁止交付", errWith(r, "缺陷未闭环"));
  api = await reg.api(b1);
  const df1 = api.defects[0].id;
  r = await tech.post(`/defects/${df1}/close`, { note: "" });
  check("闭环说明为空 → 拒绝", errWith(r, "闭环说明不能为空"));
  r = await tech.post(`/defects/${df1}/close`, { note: "重新磨边后复检合格" });
  check("闭环缺陷", ok(r));
  r = await tech.post(`/defects/${df1}/close`, { note: "再次" });
  check("重复闭环 → 拒绝", errWith(r, "禁止重复提交"));

  r = await rev.post(`/batches/${b1}/deliver`, { basis: "WT-2026-011" });
  check("审核员交付批次", ok(r));
  api = await reg.api(b1);
  check("批次与全部薄片=已交付", api.batch.status === "已交付" && api.sections.every((s) => s.status === "已交付"));
  r = await rev.post(`/batches/${b1}/deliver`, { basis: "WT-2026-011" });
  check("重复交付 → 拒绝", errWith(r, "禁止重复交付"));
  r = await tech.post(`/sections/${sec1}/advance`, { basis: "x" });
  check("已交付薄片再推进 → 拒绝（禁止回退）", errWith(r, "禁止回退"));
  r = await rev.post(`/batches/${b1}/return`, { reason: "x" });
  check("已交付批次退回 → 拒绝", errWith(r, "禁止退回"));

  console.log("== 阶段E：退回与复检留痕 ==");
  r = await reg.post("/batches", { name: "东岭铜矿二批" });
  const b2 = r.location.match(/\/batches\/(\w+)/)[1];
  r = await reg.post(`/batches/${b2}/samples`, { rockType: "石英闪长岩" });
  api = await reg.api(b2);
  const s2 = api.samples[0].id;
  await reg.post(`/samples/${s2}/sections`, { prefix: "QS-", start: "1", count: "2" });
  api = await reg.api(b2);
  for (const s of api.sections) await finishSection(tech, mic, s.id, s.code);

  r = await rev.post(`/batches/${b2}/reinspect`, { conclusion: "x" });
  check("非退回状态复检 → 拒绝（非法状态）", errWith(r, "仅退回状态"));
  r = await rev.post(`/batches/${b2}/return`, { reason: "" });
  check("退回原因为空 → 拒绝", errWith(r, "退回原因不能为空"));
  r = await rev.post(`/batches/${b2}/return`, { reason: "2片厚度超标" });
  check("审核员退回批次", ok(r));
  r = await rev.post(`/batches/${b2}/return`, { reason: "再次" });
  check("重复退回 → 拒绝", errWith(r, "禁止重复退回"));
  r = await rev.post(`/batches/${b2}/deliver`, { basis: "WT-x" });
  check("退回状态交付 → 拒绝，须先复检", errWith(r, "须先完成复检"));
  r = await rev.post(`/batches/${b2}/reinspect`, { conclusion: "" });
  check("复检结论为空 → 拒绝", errWith(r, "复检结论不能为空"));
  r = await rev.post(`/batches/${b2}/reinspect`, { conclusion: "复检合格，厚度达标" });
  check("提交复检", ok(r));
  api = await reg.api(b2);
  check("复检后批次回到进行中", api.batch.status === "进行中");
  r = await rev.post(`/batches/${b2}/deliver`, { basis: "WT-2026-012" });
  check("复检后交付成功", ok(r));

  // 留痕核查
  api = await reg.api(b2);
  const acts = api.events.map((e) => e.action);
  check("退回/复检/交付均已留痕", ["退回", "复检", "交付"].every((a) => acts.includes(a)));
  const evDeliver = api.events.find((e) => e.action === "交付");
  check("留痕含操作人/角色/时间/依据",
    evDeliver.actorName === "陈审核" && evDeliver.roleName === "审核员" && !!evDeliver.at && evDeliver.detail.includes("WT-2026-012"));
  r = await tech.get("/events");
  check("留痕日志页可查", r.status === 200 && r.text.includes("退回") && r.text.includes("复检"));

  // 工序记录含操作人/时间/依据
  r = await tech.get(`/sections/${sec1}`);
  check("薄片页展示工序记录（操作人/时间/依据）",
    r.text.includes("李制样") && r.text.includes("Q/YS-008") && r.text.includes("操作人") && r.text.includes("依据"));

  console.log("== 阶段F：逾期显示 ==");
  r = await reg.post("/batches", { name: "逾期演示批" });
  const b3 = r.location.match(/\/batches\/(\w+)/)[1];
  await reg.post(`/batches/${b3}/samples`, { rockType: "辉绿岩" });
  api = await reg.api(b3);
  await reg.post(`/samples/${api.samples[0].id}/sections`, { prefix: "YG-", start: "1", count: "1" });
  r = await tech.get(`/batches/${b3}`);
  check("新工序未逾期显示正常", r.text.includes("正常") && !r.text.includes('b-late">逾期'));

  console.log("== 阶段G：重启恢复 ==");
  await stopServer(srv);
  // 停机期间把 YG-01 的本工序进入时间回拨 5 天，制造逾期
  const dbj = JSON.parse(await readFile(DB, "utf8"));
  check("停机后数据文件存在且含交付记录", dbj.batches.length === 3 && dbj.events.some((e) => e.action === "交付"));
  const yg = dbj.sections.find((s) => s.code === "YG-01");
  yg.stepEnteredAt = new Date(Date.now() - 5 * 86400e3).toISOString();
  await writeFile(DB, JSON.stringify(dbj, null, 2));

  srv = await startServer();
  // 会话随库持久化，重启后原 cookie 仍有效
  r = await reg.get(`/api/batches/${b1}`);
  const b1After = JSON.parse(r.text);
  check("重启后批次1仍为已交付、7片齐全",
    b1After.batch.status === "已交付" && b1After.sections.length === 7 && b1After.sections.every((s) => s.status === "已交付"));
  api = await reg.api(b2);
  check("重启后批次2交付/退回/复检留痕保留",
    api.batch.status === "已交付" && ["退回", "复检", "交付"].every((a) => api.events.some((e) => e.action === a)));
  r = await tech.get(`/batches/${b3}`);
  check("重启后逾期项显示（逾期 Nh）", r.text.includes("逾期") && /逾期 \d+h/.test(r.text));
  r = await tech.get("/");
  check("批次列表显示逾期项与下一步负责人", r.text.includes("逾期 1 项") && r.text.includes("下一步负责人") && r.text.includes("制样员"));
  r = await reg.get("/events");
  check("重启后留痕日志保留", r.text.includes("东岭") || r.text.includes("交付"));

  await stopServer(srv);
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
