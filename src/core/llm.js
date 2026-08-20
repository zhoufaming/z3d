/**
 * 大模型接口桥（LLM Bridge）
 * ------------------------------------------------------------------
 * 把用户的自然语言指令经「OpenAI 兼容 Chat Completions API」翻译成
 * CommandBridge 可执行的命令计划 JSON 数组，再由 main.js 逐条下发执行，
 * 每条命令执行后视图即时刷新——实现「大模型改模型 + 实时预览」。
 *
 * 设计要点：
 *  - 纯前端 fetch（renderer 直连），走 SSE 流式接收 token；
 *  - 兼容 DeepSeek / 通义千问 / Kimi / 智谱 GLM / OpenAI / Ollama 等
 *    任何 OpenAI 兼容端点；
 *  - 配置持久化到本地 SQLite（userData/config.db），API Key 不写源码、不进 git；
 *    无主进程时（纯浏览器开发）降级到 localStorage；
 *  - prompt 内嵌完整命令清单 + 当前场景上下文，约束只返回 JSON 数组；
 *  - 解析容错：支持纯 JSON / ```json 代码块 / 文本混排中的最外层数组。
 */

const STORAGE_KEY = 'bambu3mf.llmConfig.v1';
const CFG_KEY = 'llmConfig'; // SQLite kv_store 的 key

/** 默认配置（首次使用时填充）
 *  API Key 等敏感信息不写源码，由用户在 AI 面板「配置…」里填写，
 *  保存到本地 SQLite 数据库（userData/config.db），不进 git。
 */
export const DEFAULT_LLM_CONFIG = {
  mode: 'local',        // 'local' 离线确定性解析 | 'llm' 大模型
  apiUrl: '',           // 如 https://api.deepseek.com/v1/chat/completions
  apiKey: '',           // 由用户填写，存 SQLite
  model: '',            // 如 deepseek-chat
  temperature: 0.2,     // 低温度保证命令稳定
  timeoutMs: 60000,     // 单次请求超时
};

/**
 * 从本地存储读取配置（优先 SQLite，降级 localStorage）。
 * Electron 环境下走 IPC → 主进程 → better-sqlite3；
 * 纯浏览器环境下走 localStorage。
 * @returns {Promise<object>}
 */
export async function loadLLMConfig() {
  const fallback = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_LLM_CONFIG };
      return { ...DEFAULT_LLM_CONFIG, ...JSON.parse(raw) };
    } catch (_) {
      return { ...DEFAULT_LLM_CONFIG };
    }
  };
  // Electron 主进程 IPC
  if (window.bambu && window.bambu.invoke) {
    try {
      const raw = await window.bambu.invoke('cfg:get', CFG_KEY);
      if (!raw) return { ...DEFAULT_LLM_CONFIG };
      return { ...DEFAULT_LLM_CONFIG, ...JSON.parse(raw) };
    } catch (_) {
      return fallback();
    }
  }
  return fallback();
}

/**
 * 保存配置到本地存储（优先 SQLite，降级 localStorage）。
 * @param {object} cfg
 * @returns {Promise<void>}
 */
export async function saveLLMConfig(cfg) {
  const str = JSON.stringify(cfg);
  if (window.bambu && window.bambu.invoke) {
    try {
      await window.bambu.invoke('cfg:set', CFG_KEY, str);
      return;
    } catch (_) { /* 降级 */ }
  }
  try { localStorage.setItem(STORAGE_KEY, str); } catch (_) { /* 静默 */ }
}

/**
 * 调用 OpenAI 兼容 Chat Completions，流式接收。
 * @param {object} config  { apiUrl, apiKey, model, temperature, timeoutMs }
 * @param {Array<{role:string,content:string}>} messages
 * @param {(token:string)=>void} [onToken]  每收到一段文本回调一次
 * @param {AbortSignal} [signal]  取消信号
 * @returns {Promise<string>} 完整文本
 */
export async function callLLM(config, messages, { onToken, signal } = {}) {
  const url = (config.apiUrl || '').trim();
  if (!url) throw new Error('未配置 API URL');
  const body = {
    model: config.model || 'deepseek-chat',
    messages,
    temperature: Number(config.temperature ?? 0.2),
    stream: true,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  // AbortController 合并超时与外部 signal
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(config.timeoutMs) || 60000);
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = String(err && err.message || err);
    if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
      throw new Error('网络请求失败（可能是 CORS 或 API URL 不可达）：' + msg);
    }
    throw new Error('请求失败：' + msg);
  }

  if (!resp.ok) {
    clearTimeout(timer);
    const text = await resp.text().catch(() => '');
    throw new Error(`API 返回 ${resp.status}：${text.slice(0, 300) || resp.statusText}`);
  }

  // 解析 SSE 流：data: {...}\n\n
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || ''; // 最后一行可能不完整
    for (const line of lines) {
      const s = line.trim();
      if (!s || !s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') { clearTimeout(timer); return full; }
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          if (onToken) onToken(delta);
        }
      } catch (_) { /* 跳过损坏的 SSE 行 */ }
    }
  }
  clearTimeout(timer);
  return full;
}

/**
 * 构造让大模型产出命令计划的 system+user 消息。
 * @param {object} scene  CommandBridge.cmdScene() 的返回
 * @param {object} commandDocs  CommandBridge 的 COMMAND_DOCS
 * @param {string} userText  用户原始自然语言
 */
export function buildPlanMessages(scene, commandDocs, userText) {
  const sceneBrief = {
    activePlate: scene.activePlate,
    plates: scene.plates,
    objects: scene.objects.map((o) => ({
      uid: o.uid,
      name: o.name,
      plateId: o.plateId,
      size: o.size,
      position: o.position,
      tris: o.tris,
    })),
  };
  const system = [
    '你是 Bambu 3MF Studio 的 3D 模型编辑助手。',
    '你的任务：把用户的自然语言指令翻译成「命令计划」——一个 JSON 数组，每个元素形如 {"cmd":"命令名","args":{...}}。',
    '',
    '可用命令清单（cmd → args）：',
    ...Object.entries(commandDocs).map(([k, v]) => `- ${k}：${v}`),
    '',
    '对象定位：args.targets 是字符串数组，元素可以是对象的 uid（如 "u1"）或名字子串（如 "立方体A"）。',
    '坐标单位：毫米。Y 轴是前后方向（深），Z 轴是上下方向（高）。',
    '',
    '当前场景上下文：',
    JSON.stringify(sceneBrief),
    '',
    '输出要求：',
    '1. 只返回一个 JSON 数组，不要任何解释文字、不要 markdown 代码块标记。',
    '2. 数组元素按执行顺序排列；后面的命令可以使用前面命令产生的对象（名字沿用场景中已有的）。',
    '3. 如果指令无法理解或无法执行，返回 [{"cmd":"help"}]。',
    '4. 涉及多对象的操作（boolean/merge）必须在 targets 里给出 2 个或更多对象。',
    '5. 优先用 uid 定位对象，避免名字歧义。',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: userText },
  ];
}

/**
 * 从大模型的返回文本中提取命令计划数组。
 * 容错策略：1) 直接 JSON.parse → 2) 抽 ```json 块 → 3) 抽最外层 [...] → 4) 失败返回 error
 * @param {string} text
 * @returns {{ plan: object[], error?: string }}
 */
export function extractPlanFromResponse(text) {
  const t = (text || '').trim();
  if (!t) return { plan: [], error: '大模型返回为空' };

  // 1) 直接解析（理想情况：模型遵守了"只返回 JSON"约束）
  try {
    const obj = JSON.parse(t);
    const arr = Array.isArray(obj) ? obj : [obj];
    if (arr.length && arr.every((x) => x && typeof x === 'object' && x.cmd)) return { plan: arr };
  } catch (_) { /* 继续尝试 */ }

  // 2) 抽 ```json ... ``` 代码块
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      const arr = JSON.parse(fence[1].trim());
      if (Array.isArray(arr) && arr.every((x) => x && x.cmd)) return { plan: arr };
    } catch (_) { /* 继续尝试 */ }
  }

  // 3) 抽最外层 [ ... ]
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const arr = JSON.parse(t.slice(start, end + 1));
      if (Array.isArray(arr) && arr.every((x) => x && typeof x === 'object' && x.cmd)) {
        return { plan: arr };
      }
    } catch (_) { /* 继续尝试 */ }
  }

  // 4) 抽单个 {...cmd...}
  const objStart = t.indexOf('{');
  const objEnd = t.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    try {
      const obj = JSON.parse(t.slice(objStart, objEnd + 1));
      if (obj && obj.cmd) return { plan: [obj] };
    } catch (_) { /* 放弃 */ }
  }

  return { plan: [], error: '无法从大模型返回中解析命令计划' };
}
