(() => {
  // src/shared/messages.ts
  var PAGE_TAG = "__stvDriveSync";

  // src/shared/sitedata.ts
  var TUSACH_KEY = "tusach";
  var MARK_KEY = "stv-drive-sync";
  var EXTRA_NAME_KEYS = ["qtOnline0"];
  var DEFAULT_HOSTS = [
    "uukanshu",
    "69shu",
    "69shuorg",
    "shu008",
    "xinyushuwu",
    "xiaoqiangwx",
    "cuiweijux",
    "-aikanshu",
    "-kygnew",
    "-aikanshuba",
    "biquge",
    "trxs",
    "ikshu8",
    "shulinw",
    "wuxia1",
    "xslou",
    "shu03",
    "shu05",
    "kuhu168",
    "2kxs",
    "shukw",
    "cn8118",
    "yikanxiaoshuo",
    "xiaoshuowa",
    "zwduxs",
    "8zwdu",
    "kanmaoxian",
    "kayegenet",
    "4gxsw",
    "qinqinxsw",
    "read8",
    "ciweimao",
    "wkkshu",
    "168kanshu",
    "wanbentxt",
    "38kanshu",
    "duanqingsi",
    "faloo",
    "qiuxiaoshuo",
    "dibaqu123",
    "jiacuan",
    "lsjxs2",
    "shubaow",
    "biqugeinfo",
    "shumilou",
    "xbiquge",
    "paoshu8",
    "duokan8",
    "biqugecom",
    "hetushu",
    "nofff",
    "uuxs",
    "ranwenla",
    "66wx",
    "biqugexs",
    "230book",
    "shumiloutw",
    "biqubu",
    "521danmei",
    "bxwxorg",
    "qidian",
    "zwdu",
    "xingeweb",
    "zongheng",
    "biqugese",
    "qiushubang",
    "xinshuhaige",
    "oldtimescc",
    "sinodan",
    "wuwuxs",
    "hs313",
    "shuchong",
    "shucw",
    "shumizu",
    "tadu",
    "ptwxz",
    "x81zw",
    "linovel",
    "wenku8",
    "youyoukanshu",
    "biqubao",
    "biqugele",
    "biqugebz",
    "biquge5200",
    "sfacg",
    "shubao45",
    "kujiang",
    "yushubo",
    "xklxsw",
    "fanqie",
    "xsbiquge",
    "kanman",
    "acqq",
    "cocomanga",
    "colamanga",
    "jjwxc",
    "kankeo",
    "qimao",
    "ddxs",
    "quanben5",
    "idejian",
    "dich"
  ];
  var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function nameKeyMatcher(hosts) {
    const alt = [...new Set([...DEFAULT_HOSTS, ...hosts])].filter(Boolean).map(escapeRe).join("|");
    const re = new RegExp(`^(?:${alt})\\d+`, "i");
    return (key) => EXTRA_NAME_KEYS.includes(key) || re.test(key);
  }

  // src/content/bridge.ts
  (() => {
    const w = window;
    if (w.__stvDriveSyncBridge?.())
      return;
    const alive = () => {
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    };
    w.__stvDriveSyncBridge = alive;
    const send = (msg) => {
      if (!alive())
        return;
      chrome.runtime.sendMessage(msg).catch(() => {});
    };
    let hosts = [];
    let isName = nameKeyMatcher(hosts);
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (e.source !== window || !d?.[PAGE_TAG])
        return;
      if (d.kind === "dirty" && typeof d.key === "string") {
        if (d.key === "*" || d.key === TUSACH_KEY || isName(d.key))
          send({ type: "dirty", key: d.key, t: Number(d.t) || Date.now() });
      } else if (d.kind === "hosts" && Array.isArray(d.hosts)) {
        hosts = d.hosts.filter((h) => typeof h === "string");
        isName = nameKeyMatcher(hosts);
        send({ type: "hosts", hosts });
      }
    });
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg.type === "read")
        reply(read(msg.hosts));
      else if (msg.type === "apply")
        reply(apply(msg.plan));
      return false;
    });
    function read(extraHosts) {
      const match = nameKeyMatcher([...hosts, ...extraHosts]);
      const names = {};
      for (let i = 0;i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k !== null && match(k))
          names[k] = localStorage.getItem(k) ?? "";
      }
      const stamp = /(?:^|;\s*)hstamp=(\d+)/.exec(document.cookie)?.[1];
      return {
        snapshot: { tusach: localStorage.getItem(TUSACH_KEY), names },
        stamp: stamp ? Number(stamp) * 1000 : undefined,
        marked: localStorage.getItem(MARK_KEY) !== null
      };
    }
    function apply(plan) {
      for (const [k, v] of Object.entries(plan.expect))
        if (localStorage.getItem(k) !== v)
          return { ok: false };
      const keys = Object.keys(plan.set);
      try {
        for (const k of keys) {
          const v = plan.set[k];
          if (v == null)
            localStorage.removeItem(k);
          else
            localStorage.setItem(k, v);
        }
        localStorage.setItem(MARK_KEY, "1");
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (keys.length) {
        window.postMessage({ [PAGE_TAG]: true, kind: "applied", keys }, location.origin);
        toast();
      }
      return { ok: true };
    }
    let toastTimer;
    function toast() {
      const id = "stv-drive-sync-toast";
      document.getElementById(id)?.remove();
      const host = document.createElement("div");
      host.id = id;
      host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
      div{font:13px/1.4 system-ui,sans-serif;background:#202124;color:#fff;padding:10px 12px;border-radius:8px;
        box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;max-width:320px}
      button{font:inherit;background:none;border:0;color:#8ab4f8;cursor:pointer;padding:0}
    </style><div><span>Reading history / names updated from Google Drive.</span><button>Reload</button></div>`;
      root.querySelector("button").addEventListener("click", () => location.reload());
      (document.body ?? document.documentElement).append(host);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => host.remove(), 8000);
    }
    send({ type: "hello" });
  })();
})();
