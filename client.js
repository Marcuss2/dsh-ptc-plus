(() => {
  // internal/config-spec.js
  var MAX_TIMER_DELAY_MS = 2147483647;
  var SETTINGS_NAMESPACE = "ptc-plus";
  var CONFIG_FIELDS = Object.freeze([
    {
      key: "enabled",
      type: "boolean",
      default: true,
      label: "\u542F\u7528 PTC Plus",
      description: "\u5173\u95ED\u540E PTC Plus \u4E0D\u6CE8\u518C run_code/edit_run_code\u3001\u4E0D\u4FEE\u6539\u7CFB\u7EDF\u63D0\u793A\u3001\u4E0D\u521B\u5EFA session runtime\uFF1B\u8BBE\u7F6E UI \u4ECD\u4FDD\u7559\u4E14\u4EC5\u6B64\u5F00\u5173\u53EF\u64CD\u4F5C\u3002"
    },
    {
      key: "cordisToolsEnabled",
      type: "boolean",
      default: false,
      label: "\u5728 PTC \u6A21\u5F0F\u4E2D\u542F\u7528 Cordis \u5DE5\u5177",
      description: "\u5728 PTC agent \u7684 tools.* \u4E2D\u5373\u65F6\u52A0\u5165\u6216\u79FB\u9664\u5B98\u65B9 Cordis \u5DE5\u5177\u4E0E\u6307\u5F15\u3002"
    },
    {
      key: "computeMs",
      type: "integer",
      default: 6e4,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u5355 cell \u6700\u5927 CPU \u65F6\u95F4 (ms)",
      description: "\u540C\u6B65\u8BA1\u7B97\u8D85\u8FC7\u8BE5\u9884\u7B97\u7684 cell \u4F1A\u88AB\u4E2D\u65AD\u3002"
    },
    {
      key: "maxWallMs",
      type: "integer",
      default: 6e5,
      min: 1,
      max: MAX_TIMER_DELAY_MS,
      label: "\u5355 cell \u6700\u5927\u5899\u949F\u65F6\u95F4 (ms)",
      description: "\u5B8C\u6574 cell \u6267\u884C\uFF08\u542B\u5F02\u6B65\u7B49\u5F85\uFF09\u7684\u6700\u957F\u8017\u65F6\u3002"
    },
    {
      key: "maxOutputBytes",
      type: "integer",
      default: 64 * 1024 * 1024,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u6700\u5927\u8F93\u51FA\u5B57\u8282",
      description: "PTC Value Graph \u7F16\u7801\u3001IPC\u3001journal \u548C\u6E32\u67D3\u5171\u4EAB\u7684\u5B57\u8282\u4E0A\u9650\u3002"
    },
    {
      key: "maxOldGenerationSizeMb",
      type: "integer",
      default: 512,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "worker \u65E7\u751F\u4EE3\u5185\u5B58\u4E0A\u9650 (MiB)",
      description: "\u6BCF\u4E2A session worker \u7684 V8 old-generation \u9650\u5236\uFF1B\u6D3B\u52A8 worker \u5B58\u5728\u65F6\u4FEE\u6539\u4F1A\u56DE\u6EDA\uFF0C\u5F85 session \u91CA\u653E\u540E\u751F\u6548\u3002"
    },
    {
      key: "maxValueNodes",
      type: "integer",
      default: 1e5,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "Value Graph \u6700\u5927\u8282\u70B9\u6570",
      description: "\u5355\u6B21\u8FD4\u56DE\u503C\u7684\u56FE\u8282\u70B9\u9884\u7B97\u3002"
    },
    {
      key: "maxValueEdges",
      type: "integer",
      default: 1e6,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "Value Graph \u6700\u5927\u8FB9\u6570",
      description: "\u5355\u6B21\u8FD4\u56DE\u503C\u7684\u56FE\u8FB9\u9884\u7B97\u3002"
    },
    {
      key: "maxValueArrayLength",
      type: "integer",
      default: 1e6,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u6570\u7EC4\u6700\u5927\u58F0\u660E\u957F\u5EA6",
      description: "Value Graph \u7F16\u7801\u7684\u6570\u7EC4\u957F\u5EA6\u9884\u7B97\u3002"
    },
    {
      key: "maxValueBigIntDigits",
      type: "integer",
      default: 1e5,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "BigInt \u6700\u5927\u5341\u8FDB\u5236\u4F4D\u6570",
      description: "BigInt \u7F16\u7801\u7684\u5341\u8FDB\u5236\u4F4D\u6570\u4E0A\u9650\u3002"
    },
    {
      key: "maxNestedRunCodeDepth",
      type: "integer",
      default: 8,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "code.run \u6700\u5927\u9012\u5F52\u6DF1\u5EA6",
      description: "\u9694\u79BB code.run \u7684\u5D4C\u5957\u6DF1\u5EA6\u9650\u5236\u3002"
    },
    {
      key: "canonicalizeToolCalls",
      type: "boolean",
      default: true,
      label: "\u89C4\u8303\u9876\u5C42 native \u8BEF\u8C03",
      description: "\u628A live schema \u53EF\u8BC1\u660E\u7684\u9876\u5C42 native \u8C03\u7528\u89C4\u8303\u6210 run_code cell\u3002"
    },
    {
      key: "looseTopLevelRedeclarations",
      type: "boolean",
      default: true,
      label: "\u5BBD\u677E\u9876\u5C42\u91CD\u58F0\u660E",
      description: "\u5141\u8BB8\u5B8C\u6574 const/let declarator \u66FF\u6362\u5DF2\u6709\u9876\u5C42 binding\u3002"
    },
    {
      key: "durableReplay",
      type: "boolean",
      default: true,
      label: "\u6301\u4E45\u91CD\u653E",
      description: "worker \u91CD\u5EFA\u65F6\u4ECE session log \u91CD\u653E durable cell\u3002"
    },
    {
      key: "autoRewriteImports",
      type: "boolean",
      default: true,
      label: "\u81EA\u52A8\u6539\u5199 import",
      description: "\u628A\u9759\u6001 import \u9002\u914D\u4E3A worker \u9884\u52A0\u8F7D\u7684 module namespace\u3002"
    },
    {
      key: "autoStripExports",
      type: "boolean",
      default: true,
      label: "\u81EA\u52A8\u5265\u79BB export",
      description: "\u79FB\u9664\u9876\u5C42 export \u4FEE\u9970\u7B26\u5E76\u4FDD\u7559\u58F0\u660E\u3002"
    },
    {
      key: "autoSplitRedeclarations",
      type: "boolean",
      default: true,
      label: "\u81EA\u52A8\u62C6\u5206\u6DF7\u5408\u91CD\u58F0\u660E",
      description: "\u5C06\u6DF7\u5408\u65B0\u65E7\u540D\u79F0\u7684\u9876\u5C42\u89E3\u6784\u62C6\u4E3A\u517C\u5BB9\u5199\u6CD5\u3002"
    },
    {
      key: "tipsEnabled",
      type: "boolean",
      default: true,
      label: "\u542F\u7528\u6062\u590D\u63D0\u793A",
      description: "\u5728\u91CD\u590D\u5931\u8D25\u6216 execution-world \u8BCA\u65AD\u540E\u6CE8\u5165\u6709\u754C runtime context\u3002"
    },
    {
      key: "tipCooldownMessages",
      type: "integer",
      default: 3,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u6062\u590D\u63D0\u793A\u51B7\u5374\u6B65\u6570",
      description: "\u4E24\u6B21\u540C\u7C7B\u63D0\u793A\u4E4B\u95F4\u7684\u6700\u5C0F model-context \u6B65\u6570\u3002"
    },
    {
      key: "tipEscalationFailures",
      type: "integer",
      default: 2,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      label: "\u6062\u590D\u63D0\u793A\u5347\u7EA7\u5931\u8D25\u6B21\u6570",
      description: "\u8FDE\u7EED\u672A\u89E3\u51B3\u7684\u76F8\u540C\u89E6\u53D1\u8FBE\u5230\u8BE5\u6B21\u6570\u540E\u63D0\u793A\u624D\u5347\u7EA7\u4E3A\u8BE6\u7EC6\u7248\u672C\u3002"
    }
  ]);
  var CONFIG_DEFAULTS = Object.freeze(
    Object.fromEntries(CONFIG_FIELDS.map((field) => [field.key, field.default]))
  );

  // src/client.js
  var CLIENT_STYLE_ID = "ptc-plus-client-style";
  var CLIENT_CSS = `
.ptcPlusCard{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-3,#fff);border-radius:8px;list-style:none;overflow:hidden}
.ptcPlusHeader{appearance:none;width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .16s ease}
.ptcPlusHeader:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusHeader:focus-visible,.ptcPlusButton:focus-visible,.ptcPlusInput:focus-visible{outline:2px solid var(--dsw-alias-interactive-primary,#4d6bfe);outline-offset:-2px}
.ptcPlusHeadText{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:1px}.ptcPlusName{font-size:14px;font-weight:600;line-height:20px}.ptcPlusDescription{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusStatus{display:inline-flex;align-items:center;flex:none;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:16px}.ptcPlusStatus[data-enabled=true]{color:var(--dsw-alias-state-success-primary,#16794f);background:var(--dsw-alias-state-success-tertiary,#e7f7ef)}.ptcPlusStatus[data-enabled=false]{color:var(--dsw-alias-label-tertiary,#74777d);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ptcPlusChevron{display:flex;color:var(--dsw-alias-label-tertiary,#74777d);transition:transform .18s ease}.ptcPlusChevron[data-open=true]{transform:rotate(180deg)}.ptcPlusBody{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease}.ptcPlusBody[data-open=true]{grid-template-rows:1fr}.ptcPlusBodyInner{min-height:0;overflow:hidden}.ptcPlusFields{margin:0 16px;padding:8px 0 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.ptcPlusRow{display:flex;align-items:center;gap:12px;min-height:48px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}.ptcPlusRow:first-child{border-top:0}.ptcPlusMain{flex:1;min-width:0}.ptcPlusLabel{font-size:14px;font-weight:500;line-height:20px}.ptcPlusDetail,.ptcPlusMessage{color:var(--dsw-alias-label-tertiary,#74777d);font-size:12px;line-height:18px;overflow-wrap:anywhere}.ptcPlusInput{box-sizing:border-box;min-width:72px;width:140px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:12px/18px ui-monospace,SFMono-Regular,Consolas,monospace}.ptcPlusCheck{width:18px;height:18px;accent-color:var(--dsw-alias-interactive-primary,#4d6bfe)}
.ptcPlusFooter{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}.ptcPlusButton{min-height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:500 13px/20px inherit;transition:background-color .16s ease,border-color .16s ease}.ptcPlusButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.ptcPlusButton:disabled,.ptcPlusInput:disabled,.ptcPlusCheck:disabled{cursor:not-allowed;opacity:.55}.ptcPlusActive{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-state-success-primary,#16794f);font-size:12px;line-height:18px;white-space:nowrap}
@media(max-width:560px){.ptcPlusHeader{padding:12px}.ptcPlusFields{margin:0 12px}.ptcPlusRow{align-items:flex-start;flex-direction:column;gap:6px;padding:10px 0}.ptcPlusInput{width:100%}.ptcPlusFooter{align-items:stretch;flex-direction:column}.ptcPlusButton{width:100%}}
@media(prefers-reduced-motion:reduce){.ptcPlusHeader,.ptcPlusChevron,.ptcPlusBody,.ptcPlusButton{transition:none}}
`;
  window.__ModuleLoader__.load({
    // Replaced by the bundle entry with the package name from package.json.
    id: "dsh-ptc-plus",
    factory: (require2) => {
      const React = require2("react");
      const {
        IconCheckOutline14,
        IconChevronDownOutline14,
        IconSettingsOutline16
      } = require2("@deepseek-ai/dsh-client-ui-primitives");
      const module = { exports: {} };
      const h = React.createElement;
      function installStyles() {
        if (document.getElementById(CLIENT_STYLE_ID) !== null) return () => {
        };
        const style = document.createElement("style");
        style.id = CLIENT_STYLE_ID;
        style.textContent = CLIENT_CSS;
        document.head.append(style);
        return () => style.remove();
      }
      function fieldInput(field, value, disabled, onChange) {
        if (field.type === "boolean") {
          return h("input", {
            type: "checkbox",
            role: "switch",
            className: "ptcPlusCheck",
            checked: value === true,
            disabled,
            "aria-label": field.label,
            onChange: (event) => onChange(field, event.target.checked)
          });
        }
        return h("input", {
          type: "number",
          className: "ptcPlusInput",
          value: Number.isSafeInteger(value) ? String(value) : "",
          min: field.min,
          max: field.max,
          step: 1,
          disabled,
          "aria-label": field.label,
          onChange: (event) => {
            const input = event.target.value;
            const parsed = input === "" ? "" : Number(input);
            onChange(field, Number.isSafeInteger(parsed) ? parsed : input);
          }
        });
      }
      function apply(ctx) {
        const preferenceScope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
        ctx.effect(installStyles, "ptc-plus: client styles");
        function PTCPlusSettingsCard() {
          const [open, setOpen] = React.useState(false);
          const [status, setStatus] = React.useState("");
          const [pending, setPending] = React.useState(() => /* @__PURE__ */ new Set());
          const writeTail = React.useRef(Promise.resolve());
          const subscribe = React.useCallback((listener) => preferenceScope.subscribe(listener), []);
          const getSnapshot = React.useCallback(() => preferenceScope.getSnapshot(), []);
          const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
          const value = snapshot.status === "ready" ? snapshot.value ?? {} : {};
          const enabled = value.enabled === true;
          const unavailable = snapshot.status !== "ready" || snapshot.writable !== true;
          const persist = (field, nextValue) => {
            if (unavailable || pending.has(field.key)) return;
            const operation = writeTail.current.then(async () => {
              const before = preferenceScope.getSnapshot();
              if (before.status !== "ready" || before.writable !== true) return;
              if (field.key !== "enabled" && before.value?.enabled !== true) return;
              if (before.value?.[field.key] === nextValue) return;
              setPending((current) => new Set(current).add(field.key));
              setStatus("");
              try {
                await preferenceScope.set(field.key, nextValue);
                const after = preferenceScope.getSnapshot();
                if (after.status !== "ready" || after.value?.[field.key] !== nextValue) {
                  setStatus("\u8BBE\u7F6E\u672A\u751F\u6548\uFF0C\u8BF7\u68C0\u67E5\u8BBE\u7F6E\u51B2\u7A81");
                } else {
                  setStatus("\u8BBE\u7F6E\u5DF2\u7ACB\u5373\u751F\u6548");
                }
              } catch (error) {
                setStatus("\u8BBE\u7F6E\u5931\u8D25\uFF1A" + (error instanceof Error ? error.message : String(error)));
              } finally {
                setPending((current) => {
                  const next = new Set(current);
                  next.delete(field.key);
                  return next;
                });
              }
            });
            writeTail.current = operation.catch(() => {
            });
          };
          const fieldDisabled = (field) => unavailable || pending.has(field.key) || field.key !== "enabled" && !enabled;
          return h(
            "li",
            { className: "ptcPlusCard" },
            h(
              "button",
              {
                type: "button",
                className: "ptcPlusHeader",
                "aria-expanded": open,
                "aria-label": open ? "\u6536\u8D77 PTC Plus \u8BBE\u7F6E" : "\u5C55\u5F00 PTC Plus \u8BBE\u7F6E",
                "aria-controls": "ptc-plus-settings-body",
                onClick: () => setOpen((current) => !current)
              },
              h(IconSettingsOutline16, { size: 16 }),
              h(
                "span",
                { className: "ptcPlusHeadText" },
                h("span", { className: "ptcPlusName" }, "PTC Plus"),
                h("span", { className: "ptcPlusDescription" }, "PTC \u6A21\u5F0F\u7684\u4F1A\u8BDD\u7EA7 TypeScript REPL\u3002")
              ),
              h("span", { className: "ptcPlusStatus", "data-enabled": enabled }, enabled ? "\u5DF2\u542F\u7528" : "\u5DF2\u505C\u7528"),
              h("span", { className: "ptcPlusChevron", "data-open": open, "aria-hidden": true }, h(IconChevronDownOutline14, { size: 14 }))
            ),
            h(
              "div",
              { id: "ptc-plus-settings-body", className: "ptcPlusBody", "data-open": open, "aria-hidden": !open },
              h("div", { className: "ptcPlusBodyInner" }, h(
                "div",
                { className: "ptcPlusFields" },
                snapshot.status === "loading" ? h("p", { className: "ptcPlusMessage" }, "\u6B63\u5728\u540C\u6B65\u8BBE\u7F6E...") : snapshot.status === "unavailable" ? h("p", { className: "ptcPlusMessage" }, "\u5F53\u524D DSH \u5B9E\u4F8B\u672A\u63D0\u4F9B\u8BBE\u7F6E\u670D\u52A1") : [
                  ...CONFIG_FIELDS.map((field) => h(
                    "div",
                    { key: field.key, className: "ptcPlusRow" },
                    h(
                      "div",
                      { className: "ptcPlusMain" },
                      h("div", { className: "ptcPlusLabel" }, field.label),
                      h("div", { className: "ptcPlusDetail" }, field.description)
                    ),
                    fieldInput(field, value[field.key], fieldDisabled(field), persist)
                  )),
                  h(
                    "div",
                    { key: "footer", className: "ptcPlusFooter" },
                    h("span", { className: "ptcPlusMessage", role: "status" }, status || (snapshot.writable ? "\u8BBE\u7F6E\u4F1A\u5728\u4FEE\u6539\u540E\u7ACB\u5373\u751F\u6548" : "\u5F53\u524D\u8BBE\u7F6E\u4E3A\u53EA\u8BFB"))
                  )
                ]
              ))
            )
          );
        }
        ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
          name: "settings.plugin.item",
          key: SETTINGS_NAMESPACE
        }, PTCPlusSettingsCard));
        ctx.inject(["slots", "sessions"], (scope) => {
          function PTCPlusSessionIndicator({ sessionId }) {
            const sessions = React.useSyncExternalStore(
              (listener) => scope.sessions.list.subscribe(listener),
              () => scope.sessions.list.getSnapshot(),
              () => scope.sessions.list.getSnapshot()
            );
            const settings = React.useSyncExternalStore(
              (listener) => preferenceScope.subscribe(listener),
              () => preferenceScope.getSnapshot(),
              () => preferenceScope.getSnapshot()
            );
            if (sessions.byId?.[sessionId]?.agentPreset !== "code" || settings.status !== "ready" || settings.value?.enabled !== true) return null;
            return h(
              "span",
              { className: "ptcPlusActive", title: "PTC Plus \u5DF2\u542F\u7528" },
              h(IconCheckOutline14, { size: 14 }),
              "PTC Plus"
            );
          }
          scope.slots.inject("conversation.session.header.actions", () => scope.slots.register({
            name: "conversation.session.header.actions",
            id: "ptc-plus-active",
            order: -9
          }, PTCPlusSessionIndicator));
        });
      }
      module.exports = { apply, inject: ["settingsScope", "slots", "sessions"] };
      return module.exports;
    }
  });
})();
