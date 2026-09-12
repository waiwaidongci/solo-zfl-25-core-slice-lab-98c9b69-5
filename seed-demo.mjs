// 演示数据灌入：按真实用户操作流程走一遍（登录→建档→批量录入→推进→观察→交付/退回/复检）
// 运行：node seed-demo.mjs   （要求服务已在 3025 端口运行，且数据库为空）
const BASE = process.env.BASE || "http://127.0.0.1:3025";

function client() {
  let cookie = "";
  async function req(method, path, body) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    const res = await fetch(BASE + path, {
      method, headers, redirect: "manual",
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    const setc = res.headers.get("set-cookie");
    if (setc) cookie = setc.split(";")[0];
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get("location") || "" };
  }
  return {
    get: (p) => req("GET", p),
    post: (p, b) => req("POST", p, b ?? {}),
    async api(id) { return JSON.parse((await req("GET", `/api/batches/${id}`)).text); },
  };
}
const must = (r, what) => {
  if (r.status !== 303 || r.location.includes("err=")) throw new Error(`${what} 失败: ${r.location}`);
  return r;
};

async function finish(tech, mic, secId, code) {
  for (let s = 1; s <= 5; s++)
    must(await tech.post(`/sections/${secId}/advance`, { basis: "Q/YS-008-2024 制样规程", stepNo: String(s) }), `${code} 工序${s}`);
  must(await mic.post(`/sections/${secId}/observe`, {
    conclusion: "花岗闪长岩，半自形粒状结构，见黄铜矿化，粒度0.2-1.0mm",
    basis: "DZ/T 0275 岩矿鉴定规程",
  }), `${code} 镜检`);
}

const reg = client(), tech = client(), mic = client(), rev = client();
must(await reg.post("/login", { username: "reg1", password: "reg123" }), "登录reg1");
must(await tech.post("/login", { username: "tech1", password: "tech123" }), "登录tech1");
must(await mic.post("/login", { username: "mic1", password: "mic123" }), "登录mic1");
must(await rev.post("/login", { username: "rev1", password: "rev123" }), "登录rev1");

// 批次一：完整走通并交付
let r = await reg.post("/batches", { name: "东岭铜矿一批", note: "钻孔ZK-17" });
const b1 = r.location.match(/\/batches\/(\w+)/)[1];
await reg.post(`/batches/${b1}/samples`, { rockType: "花岗闪长岩", note: "128.4-128.8m" });
let api = await reg.api(b1);
await reg.post(`/samples/${api.samples[0].id}/sections`, { prefix: "DL-", start: "1", count: "4" });
api = await reg.api(b1);
for (const s of api.sections) await finish(tech, mic, s.id, s.code);
// 报一个缺陷并闭环，演示缺陷流程
await tech.post(`/sections/${api.sections[1].id}/defects`, { desc: "盖片气泡" });
api = await reg.api(b1);
await tech.post(`/defects/${api.defects[0].id}/close`, { note: "重新盖片，气泡消除" });
must(await rev.post(`/batches/${b1}/deliver`, { basis: "委托单 WT-2026-011" }), "批次一交付");
console.log("批次一：4片全部走完并交付");

// 批次二：退回→复检→交付
r = await reg.post("/batches", { name: "西沟铁矿试验批", note: "钻孔ZK-03" });
const b2 = r.location.match(/\/batches\/(\w+)/)[1];
await reg.post(`/batches/${b2}/samples`, { rockType: "石英闪长岩" });
api = await reg.api(b2);
await reg.post(`/samples/${api.samples[0].id}/sections`, { codesText: "XG-01\nXG-02\nXG-03" });
api = await reg.api(b2);
for (const s of api.sections) await finish(tech, mic, s.id, s.code);
must(await rev.post(`/batches/${b2}/return`, { reason: "XG-02 厚度抽检超标" }), "批次二退回");
must(await rev.post(`/batches/${b2}/reinspect`, { conclusion: "复测厚度合格，同意交付" }), "批次二复检");
must(await rev.post(`/batches/${b2}/deliver`, { basis: "委托单 WT-2026-012" }), "批次二交付");
console.log("批次二：退回→复检→交付");

// 批次三：进行中（演示当前工序/下一步负责人；YG-01 稍后在库中回拨时间制造逾期）
r = await reg.post("/batches", { name: "北山金矿一批", note: "钻孔ZK-88" });
const b3 = r.location.match(/\/batches\/(\w+)/)[1];
await reg.post(`/batches/${b3}/samples`, { rockType: "石英脉型金矿石" });
api = await reg.api(b3);
await reg.post(`/samples/${api.samples[0].id}/sections`, { prefix: "BS-", start: "1", count: "3" });
api = await reg.api(b3);
const [bs1, bs2] = api.sections;
for (let s = 1; s <= 3; s++)
  await tech.post(`/sections/${bs1.id}/advance`, { basis: "Q/YS-008-2024", stepNo: String(s) });
await tech.post(`/sections/${bs1.id}/advance`, { basis: "Q/YS-008-2024", stepNo: "4" });
await tech.post(`/sections/${bs2.id}/advance`, { basis: "Q/YS-008-2024", stepNo: "1" });
await mic.post(`/sections/${bs2.id}/defects`, { desc: "边缘崩缺，待修复" });
console.log("批次三：进行中（含在制薄片与未闭环缺陷）");
console.log(`演示数据完成：批次 ${b1}(已交付) ${b2}(退回复检后交付) ${b3}(进行中)`);
