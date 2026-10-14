(() => {
  // src/shared/messages.ts
  var PAGE_TAG = "__stvDriveSync";

  // src/content/hook.ts
  (() => {
    const w = window;
    if (w.__stvDriveSyncHook)
      return;
    w.__stvDriveSyncHook = true;
    const post = (data) => window.postMessage({ [PAGE_TAG]: true, ...data }, location.origin);
    const proto = Storage.prototype;
    const { setItem, removeItem, clear } = proto;
    const touched = (store, key) => {
      try {
        if (store === window.localStorage)
          post({ kind: "dirty", key, t: Date.now() });
      } catch {}
    };
    proto.setItem = function(key, value) {
      setItem.call(this, key, value);
      touched(this, String(key));
    };
    proto.removeItem = function(key) {
      removeItem.call(this, key);
      touched(this, String(key));
    };
    proto.clear = function() {
      clear.call(this);
      touched(this, "*");
    };
    const sendHosts = () => {
      if (w.hmeta && typeof w.hmeta === "object")
        post({ kind: "hosts", hosts: Object.keys(w.hmeta) });
    };
    window.addEventListener("load", () => setTimeout(sendHosts, 1500));
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (e.source !== window || !d?.[PAGE_TAG] || d.kind !== "applied" || !d.keys)
        return;
      const keys = d.keys;
      const hid = document.getElementById("hiddenid")?.textContent?.split(";");
      if (hid && hid.length >= 3) {
        const key = w.setting?.onlyonename ? "qtOnline0" : `${hid[2]}${hid[0]}`;
        const editor = w.namew ?? document.getElementById("namewd");
        if (keys.includes(key) && editor)
          editor.value = (localStorage.getItem(key) ?? "").split("~//~").join(`
`);
      }
      const list = document.getElementById("tusach");
      if (keys.includes("tusach") && list && typeof w.reloadBook === "function") {
        list.innerHTML = "";
        w.reloadBook();
      }
    });
  })();
})();
