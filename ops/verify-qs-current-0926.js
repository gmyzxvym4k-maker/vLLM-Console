// 快启固化档等价性校验：预设 params →(复刻 scriptModelLaunchPlan 映射)→ FN_* ≟ 实跑落盘 env
const fs = require("fs");
const cards = JSON.parse(fs.readFileSync("/home/ll/deploy/quickstart-presets.json", "utf8"));
const p = cards.flashnext.presets.find((x) => x.standard);
const d = p.params;
const num = parseFloat, int = parseInt;
const env = {};
env.FN_PORT = String(d.port); env.FN_SERVED = d.servedName;
env.FN_MAXLEN = String(d.maxModelLen);
env.FN_GPUMEM = String(num(d.gpuMemUtil)); env.FN_SEQS = String(int(d.maxNumSeqs));
env.FN_BLOCK = String(int(d.blockSize)); env.FN_MBTOKENS = String(int(d.maxBatchedTokens));
env.FN_PP = "2";
env.FN_PREFIX_CACHE = String(String(d.prefixCaching) === "0" ? 0 : 1);
env.FN_CHUNKED = String(String(d.chunkedPrefill) === "0" ? 0 : 1);
env.FN_ASYNC = String(String(d.asyncScheduling) === "0" ? 0 : 1);
if (String(d.kvoff) === "0") { env.FN_KVOFF = "0"; }
else { env.FN_KVOFF = "1"; env.FN_KVOFF_BYTES = String(int(d.kvoffGiB) * 1073741824); }
env.FN_PLE_INT8 = String(d.pleInt8) === "0" ? "0" : "1";
env.FN_PLE_LOC = String(d.pleLoc) === "heap" ? "heap" : "disk";
const gen = {
  temperature: num(d.temperature), top_p: num(d.topP), top_k: int(d.topK),
  min_p: num(d.minP), presence_penalty: num(d.presencePenalty), repetition_penalty: num(d.repetitionPenalty),
};
env.FN_GENCFG = JSON.stringify(gen);
if (String(d.mtp) === "1") env.FN_SPEC = JSON.stringify({ method: "mtp", num_speculative_tokens: int(d.mtpTokens), use_local_argmax_reduction: false });
// 实跑 env：wrapper printf %q 转义，去反斜杠还原
const real = {};
fs.readFileSync("/home/ll/deploy/flash-next-w4a16-launch.env", "utf8").split("\n").forEach((l) => {
  const i = l.indexOf("=");
  if (i < 0 || l.startsWith("#")) return;
  real[l.slice(0, i)] = l.slice(i + 1).replace(/\\/g, "");
});
delete real.FN_MODEL_PATH;
let bad = 0;
const keys = new Set([...Object.keys(env), ...Object.keys(real)]);
for (const k of keys) {
  if (env[k] === undefined) { console.log("预设不产生但实跑有: " + k + "=" + real[k]); bad++; continue; }
  if (real[k] === undefined) { console.log("实跑没有但预设产生: " + k + "=" + env[k]); bad++; continue; }
  if (env[k] !== real[k]) { console.log("不一致 " + k + ": 预设=" + env[k] + " 实跑=" + real[k]); bad++; }
}
console.log(bad === 0 ? "全部一致（预设启动 ≡ 当前实跑）" : "共 " + bad + " 处不一致");
