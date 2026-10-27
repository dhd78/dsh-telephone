/**
 * 电话 · 浏览器半侧。
 *
 * The owner-facing switchboard lives in the plugin page:
 *   - drag from one resident node to another to draw an allowed line;
 *   - click a line to set its max call count;
 *   - assign each Session's new-line creation quota;
 *   - inspect active lines and hang up.
 *
 * No session data is rendered here: the Host returns a thin snapshot.
 */

window.__ModuleLoader__.load({
  id: "dsh-telephone",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;

    const API = "/api/telephone-v8";
    const W = 680;
    const H = 380;
    const CX = W / 2;
    const CY = H / 2;
    const NODE_R = 27;
    const DROP_R = 52;

    const CSS = [
      ".tel{display:flex;flex-direction:column;gap:12px;max-width:880px;color:var(--dsw-alias-label-primary);font-size:12px}",
      ".tel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}",
      ".tel-title{font-size:14px;font-weight:600;margin:0}",
      ".tel-hint{color:var(--dsw-alias-label-secondary);line-height:1.65}",
      ".tel-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
      ".tel-toggle{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;user-select:none}",
      ".tel-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 10px;border-radius:7px;cursor:pointer}",
      ".tel-btn:hover{border-color:var(--dsw-alias-brand-primary)}",
      ".tel-btn[disabled]{opacity:.5;cursor:default}",
      ".tel-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
      ".tel-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".tel-ok{color:var(--dsw-alias-state-success-primary)}",
      ".tel-err{color:var(--dsw-alias-state-error-primary)}",
      ".tel-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px}",
      ".tel-graph{width:100%;height:auto;display:block;border-radius:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);touch-action:none}",
      ".tel-node{cursor:grab}",
      ".tel-node:active{cursor:grabbing}",
      ".tel-circle{stroke-width:2}",
      ".tel-label{font-size:12px;font-weight:600;fill:var(--dsw-alias-label-primary);pointer-events:none}",
      ".tel-sub{font-size:10px;fill:var(--dsw-alias-label-secondary);pointer-events:none}",
      ".tel-quota{font-size:10px;font-weight:600;fill:var(--dsw-alias-label-secondary);pointer-events:none}",
      ".tel-edge{stroke:var(--dsw-alias-border-l2);stroke-width:2;fill:none}",
      ".tel-edge-selected{stroke:var(--dsw-alias-brand-primary);stroke-width:3}",
      ".tel-edge-hit{stroke:transparent;stroke-width:14;fill:none;cursor:pointer}",
      ".tel-edge-label{font-size:10px;fill:var(--dsw-alias-label-secondary);pointer-events:none}",
      ".tel-drag{stroke:var(--dsw-alias-brand-primary);stroke-width:2;stroke-dasharray:5 4;fill:none;pointer-events:none}",
      ".tel-list{display:flex;flex-direction:column;gap:6px}",
      ".tel-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".tel-row:last-child{border-bottom:0}",
      ".tel-name{min-width:160px;font-weight:600}",
      ".tel-muted{color:var(--dsw-alias-label-secondary)}",
      ".tel-input{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 7px;font:inherit;font-size:12px}",
      ".tel-num{width:64px}",
      ".tel-quota-num{width:64px;text-align:right;font-variant-numeric:tabular-nums}",
      ".tel-badge{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:10px;color:var(--dsw-alias-label-secondary)}",
      ".tel-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary)}",
      ".tel-dot.live{background:var(--dsw-alias-state-success-primary)}",
      ".tel-dot.busy{background:var(--dsw-alias-state-warning-primary)}",
      ".tel-dot.off{background:var(--dsw-alias-label-secondary)}",
      ".tel-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".tel-detail{display:flex;flex-direction:column;gap:8px}",
      ".tel-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".tel-field label{min-width:72px;color:var(--dsw-alias-label-secondary)}",
      ".tel-sep{height:1px;background:var(--dsw-alias-border-l1);margin:4px 0}",
      ".tel-empty{color:var(--dsw-alias-label-secondary);padding:14px;text-align:center;line-height:1.7}"
    ].join("");

    function installStyle() {
      if (typeof document === "undefined" || !document.head) return () => {};
      if (document.querySelector('style[data-plugin="dsh-telephone"]')) return () => {};
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-telephone";
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag);
      };
    }

    function pairKey(a, b) {
      return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    }

    function shortId(id) {
      if (typeof id !== "string") return "?";
      return id.length <= 10 ? id : id.slice(-8);
    }

    function remainingText(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "已结束";
      const minutes = Math.ceil(ms / 60000);
      return minutes >= 60 ? "约 60 分钟" : `约 ${minutes} 分钟`;
    }

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        ...options
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.message || data.error || `HTTP ${response.status}`);
      }
      return data;
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [aliasDraft, setAliasDraft] = useState({});
      const [enabledDraft, setEnabledDraft] = useState({});
      const [selectedNode, setSelectedNode] = useState(null);
      const [selectedEdge, setSelectedEdge] = useState(null);
      const [edgeMax, setEdgeMax] = useState(6);
      const [drag, setDrag] = useState(null);
      const [message, setMessage] = useState("");
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      const svgRef = useRef(null);

      const applyState = (data) => {
        setState(data);
        setAliasDraft((previous) => {
          const next = { ...previous };
          for (const session of data.sessions || []) {
            if (next[session.sessionId] === undefined) next[session.sessionId] = session.alias;
          }
          return next;
        });
        setEnabledDraft((previous) => {
          const next = { ...previous };
          for (const session of data.sessions || []) {
            if (next[session.sessionId] === undefined) next[session.sessionId] = session.enabled;
          }
          return next;
        });
      };

      const load = async () => {
        try {
          const data = await api("/state");
          applyState(data);
        } catch (loadError) {
          setError(String(loadError.message || loadError));
        }
      };

      useEffect(() => {
        void load();
        const timer = setInterval(() => { void load(); }, 4000);
        return () => clearInterval(timer);
      }, []);

      const sessions = state?.sessions ?? [];
      const links = state?.links ?? [];
      const lines = state?.lines ?? [];
      const graphSessions = sessions.filter((session) => session.inPhonebook === true);
      const nodeById = useMemo(() => new Map(graphSessions.map((session) => [session.sessionId, session])), [graphSessions]);

      const nodes = useMemo(() => {
        const count = graphSessions.length;
        const radius = count <= 1 ? 0 : Math.min(155, 78 + count * 8);
        return graphSessions.map((session, index) => {
          const angle = count <= 1 ? 0 : -Math.PI / 2 + (index * 2 * Math.PI) / count;
          return {
            ...session,
            x: CX + Math.cos(angle) * radius,
            y: CY + Math.sin(angle) * radius
          };
        });
      }, [graphSessions]);

      const nodePosition = useMemo(() => new Map(nodes.map((node) => [node.sessionId, node])), [nodes]);
      const activeLineByPair = useMemo(() => {
        const map = new Map();
        for (const line of lines) {
          if (line.status === "active") map.set(pairKey(line.a, line.b), line);
        }
        return map;
      }, [lines]);
      const dense = links.length > 24;

      const aliasOf = (session) => aliasDraft[session.sessionId] ?? session.alias;
      const enabledOf = (session) => enabledDraft[session.sessionId] ?? session.enabled;

      const run = async (action, success) => {
        setBusy(true);
        setError("");
        setMessage("");
        try {
          const result = await action();
          if (result && Array.isArray(result.sessions)) applyState(result);
          else if (result) applyState(result.state ?? result);
          if (success) setMessage(success);
        } catch (actionError) {
          setError(String(actionError.message || actionError));
        } finally {
          setBusy(false);
        }
      };

      const saveRoster = () => run(async () => {
        const entries = graphSessions.map((session) => ({
          sessionId: session.sessionId,
          alias: String(aliasOf(session)).trim() || shortId(session.sessionId),
          enabled: enabledOf(session)
        }));
        return api("/roster", { method: "POST", body: JSON.stringify({ entries }) });
      }, "电话簿已保存。");

      const addToPhonebook = (session) => run(async () => {
        const alias = String(aliasDraft[session.sessionId] ?? session.title ?? shortId(session.sessionId)).trim();
        const result = await api("/roster", {
          method: "POST",
          body: JSON.stringify({
            entries: [{
              sessionId: session.sessionId,
              alias: alias || shortId(session.sessionId),
              enabled: true
            }]
          })
        });
        setSelectedNode(session.sessionId);
        return result;
      }, "已加入电话簿；现在可以拖线连接。");

      const setQuota = (session, quota) => run(async () => api("/quota", {
        method: "POST",
        body: JSON.stringify({ sessionId: session.sessionId, quota })
      }));

      const removeFromPhonebook = (session) => {
        const activeCount = activeLines.filter((line) => line.a === session.sessionId || line.b === session.sessionId).length;
        const prompt = `确定把「${aliasOf(session)}」移出电话簿？\n` +
          `相关电话线会删除${activeCount > 0 ? `，${activeCount} 条活跃专线会先挂断` : ""}；只移出电话簿，不删除 DSH 会话本身。`;
        if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(prompt)) return;
        setSelectedNode(null);
        setSelectedEdge(null);
        void run(async () => api("/roster/remove", {
          method: "POST",
          body: JSON.stringify({ sessionId: session.sessionId })
        }), `已把 ${aliasOf(session)} 移出电话簿，相关电话线已删除。`);
      };

      const toggleColdResume = (event) => {
        const checked = event.target.checked;
        void run(async () => api("/settings", {
          method: "POST",
          body: JSON.stringify({ allowColdResume: checked })
        }), checked ? "已允许唤醒离线会话。" : "已禁止唤醒离线会话；离线目标会直接报错。");
      };

      const saveLinks = (nextLinks, success) => run(async () => api("/links", {
        method: "POST",
        body: JSON.stringify({ links: nextLinks })
      }), success);

      const connectAll = () => {
        const targets = graphSessions.filter((session) => enabledOf(session));
        if (targets.length < 2) {
          setMessage("至少需要两个已启用的电话簿住户。");
          return;
        }
        const existing = new Set(links.map((link) => pairKey(link.a, link.b)));
        const next = [...links];
        let added = 0;
        for (let i = 0; i < targets.length; i += 1) {
          for (let j = i + 1; j < targets.length; j += 1) {
            const key = pairKey(targets[i].sessionId, targets[j].sessionId);
            if (existing.has(key)) continue;
            existing.add(key);
            next.push({ a: targets[i].sessionId, b: targets[j].sessionId, max: 6 });
            added += 1;
          }
        }
        setSelectedEdge(null);
        if (added === 0) {
          setMessage(`这 ${targets.length} 个住户已经全部互拉，无需新增。`);
          return;
        }
        void saveLinks(next, `已为 ${targets.length} 个住户补上 ${added} 条互拉电话线（已有线保留原 max）。`);
      };

      const clearAllLinks = () => {
        if (links.length === 0 && activeLines.length === 0) {
          setMessage("当前没有电话线，不需要清空。");
          return;
        }
        const activeCount = activeLines.length;
        const prompt = activeCount > 0
          ? `确定清空全部 ${links.length} 条电话线？\n当前还有 ${activeCount} 条活跃专线，会先逐条挂断（双方收到安静通知）。`
          : `确定清空全部 ${links.length} 条电话线？`;
        if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(prompt)) return;
        void run(async () => {
          // Hang up live lines first, then remove the whitelist.
          for (const line of [...activeLines]) {
            await api("/hangup", { method: "POST", body: JSON.stringify({ lineId: line.id }) });
          }
          return api("/links", { method: "POST", body: JSON.stringify({ links: [] }) });
        }, "已清空全部电话线；活跃专线已先挂断。");
      };

      const addLink = (a, b) => {
        if (a === b) return;
        if (links.some((link) => pairKey(link.a, link.b) === pairKey(a, b))) {
          setSelectedEdge(pairKey(a, b));
          setMessage("这条线已经存在。");
          return;
        }
        const next = [...links, { a, b, max: 6 }];
        void saveLinks(next, "连线已保存；点线可改最大通话次数。");
      };

      const removeSelectedLink = () => {
        if (!selectedEdge) return;
        const next = links.filter((link) => pairKey(link.a, link.b) !== selectedEdge);
        void saveLinks(next, "连线已删除。");
        setSelectedEdge(null);
      };

      const saveSelectedEdgeMax = () => {
        if (!selectedEdge) return;
        const next = links.map((link) => pairKey(link.a, link.b) === selectedEdge
          ? { ...link, max: Math.max(2, Math.min(30, Number(edgeMax) || 6)) }
          : link);
        void saveLinks(next, "最大通话次数已保存。");
      };

      const hangup = (line) => run(async () => api("/hangup", {
        method: "POST",
        body: JSON.stringify({ lineId: line.id })
      }), `已挂断 ${line.id}。`);

      const selectEdge = (link) => {
        setSelectedEdge(pairKey(link.a, link.b));
        setEdgeMax(link.max);
      };

      const graphPoint = (event) => {
        const svg = svgRef.current;
        if (!svg) return null;
        const rect = svg.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return {
          x: ((event.clientX - rect.left) * W) / rect.width,
          y: ((event.clientY - rect.top) * H) / rect.height
        };
      };

      const onNodeDown = (event, node) => {
        event.stopPropagation();
        setSelectedNode(node.sessionId);
        setDrag({ from: node.sessionId, sx: node.x, sy: node.y, x: node.x, y: node.y });
        if (event.currentTarget && typeof event.currentTarget.setPointerCapture === "function") {
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        }
      };

      const onGraphMove = (event) => {
        if (!drag) return;
        const point = graphPoint(event);
        if (!point) return;
        setDrag((previous) => previous ? { ...previous, ...point } : previous);
      };

      const onGraphUp = (event) => {
        if (!drag) return;
        const point = graphPoint(event) || { x: drag.x, y: drag.y };
        let target = null;
        let best = DROP_R * DROP_R;
        for (const node of nodes) {
          if (node.sessionId === drag.from) continue;
          const dx = node.x - point.x;
          const dy = node.y - point.y;
          const distance = dx * dx + dy * dy;
          if (distance <= best) {
            best = distance;
            target = node.sessionId;
          }
        }
        if (target) addLink(drag.from, target);
        setDrag(null);
      };

      const selectedSession = selectedNode ? nodeById.get(selectedNode) : null;
      const selectedLink = selectedEdge
        ? links.find((link) => pairKey(link.a, link.b) === selectedEdge)
        : null;
      const selectedLine = selectedLink ? activeLineByPair.get(pairKey(selectedLink.a, selectedLink.b)) : null;
      const activeLines = lines.filter((line) => line.status === "active");

      if (state === null) {
        return h("div", { className: "tel" },
          h("div", { className: "tel-hint" }, error ? h("span", { className: "tel-err" }, error) : "读取电话簿…")
        );
      }

      const graph = h("svg", {
        ref: svgRef,
        className: "tel-graph",
        viewBox: `0 0 ${W} ${H}`,
        role: "img",
        "aria-label": "电话连线图",
        onPointerMove: onGraphMove,
        onPointerUp: onGraphUp,
        onPointerLeave: () => setDrag(null)
      },
        links.map((link) => {
          const left = nodePosition.get(link.a);
          const right = nodePosition.get(link.b);
          if (!left || !right) return null;
          const key = pairKey(link.a, link.b);
          const active = activeLineByPair.get(key);
          const selected = selectedEdge === key;
          const label = active ? `${active.count}/${link.max}` : String(link.max);
          const midX = (left.x + right.x) / 2;
          const midY = (left.y + right.y) / 2;
          return h("g", { key: `edge-${key}` },
            h("line", {
              className: "tel-edge-hit",
              x1: left.x, y1: left.y, x2: right.x, y2: right.y,
              onClick: () => selectEdge(link)
            }),
            h("line", {
              className: selected ? "tel-edge tel-edge-selected" : "tel-edge",
              x1: left.x, y1: left.y, x2: right.x, y2: right.y
            }),
            !dense || selected ? h("text", {
              className: "tel-edge-label",
              x: midX, y: midY - 5, textAnchor: "middle"
            }, label) : null
          );
        }),
        drag ? h("line", {
          className: "tel-drag",
          x1: drag.sx, y1: drag.sy,
          x2: drag.x, y2: drag.y
        }) : null,
        nodes.map((node) => {
          const line = activeLines.find((item) => item.a === node.sessionId || item.b === node.sessionId);
          const selected = selectedNode === node.sessionId;
          const dotClass = node.running ? "tel-dot busy" : node.live ? "tel-dot live" : "tel-dot off";
          return h("g", {
            key: node.sessionId,
            className: "tel-node",
            transform: `translate(${node.x} ${node.y})`,
            onPointerDown: (event) => onNodeDown(event, node)
          },
            h("circle", {
              className: "tel-circle",
              r: NODE_R,
              fill: selected ? "var(--dsw-alias-bg-layer-2)" : "var(--dsw-alias-bg-layer-1)",
              stroke: selected ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-border-l2)"
            }),
            h("text", { className: "tel-label", y: 2, textAnchor: "middle" }, aliasOf(node).slice(0, 8)),
            h("text", { className: "tel-sub", y: 16, textAnchor: "middle" }, node.quota > 0 ? `配额 ${node.quota}` : "配额 0"),
            h("circle", {
              className: dotClass, cx: 19, cy: -19, r: 4,
              fill: node.running
                ? "var(--dsw-alias-state-warning-primary)"
                : node.live
                  ? "var(--dsw-alias-state-success-primary)"
                  : "var(--dsw-alias-label-secondary)"
            }),
            line ? h("text", { className: "tel-quota", y: -34, textAnchor: "middle" }, `${line.count}/${line.max}`) : null
          );
        }),
        drag ? nodes.filter((node) => node.sessionId === drag.from).map((node) => h("circle", {
          key: "drag-source",
          cx: node.x, cy: node.y, r: 32,
          fill: "none", stroke: "var(--dsw-alias-brand-primary)",
          strokeWidth: 2, strokeDasharray: "4 4", pointerEvents: "none"
        })) : null
      );

      const nodeDetail = selectedSession ? h("div", { className: "tel-panel tel-detail" },
        h("div", { className: "tel-row" },
          h("span", { className: "tel-name" }, aliasOf(selectedSession)),
          h("span", { className: "tel-badge" },
            h("span", { className: `tel-dot ${selectedSession.running ? "busy" : selectedSession.live ? "live" : "off"}` }),
            selectedSession.running ? "正在跑" : selectedSession.live ? "在线" : "离线"
          )
        ),
        h("div", { className: "tel-code" }, `${selectedSession.sessionId} · ${selectedSession.cwd || "未知目录"}`),
        h("div", { className: "tel-sep" }),
        h("div", { className: "tel-field" },
          h("label", null, "电话别名"),
          h("input", {
            className: "tel-input",
            value: aliasOf(selectedSession),
            onChange: (event) => setAliasDraft((previous) => ({ ...previous, [selectedSession.sessionId]: event.target.value }))
          }),
          h("label", { style: { display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0 } },
            h("input", {
              type: "checkbox",
              checked: enabledOf(selectedSession),
              onChange: (event) => setEnabledDraft((previous) => ({ ...previous, [selectedSession.sessionId]: event.target.checked }))
            }),
            "启用"
          )
        ),
        h("div", { className: "tel-field" },
          h("label", null, "创建次数"),
          h("button", {
            className: "tel-btn", type: "button", disabled: busy,
            onClick: () => setQuota(selectedSession, Math.max(0, selectedSession.quota - 1))
          }, "−"),
          h("span", { className: "tel-quota-num" }, selectedSession.quota),
          h("button", {
            className: "tel-btn", type: "button", disabled: busy,
            onClick: () => setQuota(selectedSession, selectedSession.quota + 1)
          }, "+")
        ),
        h("div", { className: "tel-hint" }, "新建一条专线消耗 1 次；已有专线内通话不消耗。"),
        h("div", { className: "tel-actions" },
          h("button", { className: "tel-btn tel-primary", type: "button", disabled: busy, onClick: saveRoster }, "保存电话簿"),
          h("button", { className: "tel-btn tel-danger", type: "button", disabled: busy, onClick: () => removeFromPhonebook(selectedSession) }, "移出电话簿")
        )
      ) : h("div", { className: "tel-panel tel-empty" }, "点左侧节点查看住户；拖两个节点之间的线表示允许互打。");

      const edgeDetail = selectedLink ? h("div", { className: "tel-panel tel-detail" },
        h("div", { className: "tel-row" },
          h("span", { className: "tel-name" }, `${aliasOf(nodeById.get(selectedLink.a) || { sessionId: selectedLink.a, alias: shortId(selectedLink.a) })} ↔ ${aliasOf(nodeById.get(selectedLink.b) || { sessionId: selectedLink.b, alias: shortId(selectedLink.b) })}`),
          selectedLine ? h("span", { className: "tel-badge" }, h("span", { className: "tel-dot busy" }), `通话中 ${selectedLine.count}/${selectedLine.max}`) : null
        ),
        h("div", { className: "tel-field" },
          h("label", null, "最大次数"),
          h("input", {
            className: "tel-input tel-num",
            type: "number", min: 2, max: 30,
            value: edgeMax,
            onChange: (event) => setEdgeMax(event.target.value)
          }),
          h("button", { className: "tel-btn tel-primary", type: "button", disabled: busy, onClick: saveSelectedEdgeMax }, "保存"),
          h("button", { className: "tel-btn tel-danger", type: "button", disabled: busy, onClick: removeSelectedLink }, "删除连线")
        ),
        h("div", { className: "tel-hint" }, "第一次呼叫算 1 次；达到最大次数后专线结束，下一次呼叫消耗新的创建次数。")
      ) : null;

      const activePanel = h("div", { className: "tel-panel" },
        h("div", { className: "tel-row" },
          h("span", { className: "tel-name" }, "活跃专线"),
          h("span", { className: "tel-muted" }, `${activeLines.length} 条`)
        ),
        activeLines.length === 0
          ? h("div", { className: "tel-hint" }, "当前没有活跃专线。")
          : h("div", { className: "tel-list" }, activeLines.map((line) => h("div", { className: "tel-row", key: line.id },
            h("span", { className: "tel-code" }, line.id),
            h("span", { className: "tel-name" }, `${shortId(line.a)} ↔ ${shortId(line.b)}`),
            h("span", { className: "tel-muted" }, `${line.count}/${line.max}，剩 ${remainingText(line.remainingMs)}`),
            h("button", { className: "tel-btn tel-danger", type: "button", disabled: busy, onClick: () => hangup(line) }, "挂断")
          )))
      );

      const rosterPanel = h("details", { className: "tel-panel" },
        h("summary", { className: "tel-name" }, "电话簿 / 住户映射"),
        h("div", { className: "tel-hint" }, "先把住户加入电话簿，再回上方拖线。这里默认不把陌生会话画进图，避免误拨；别名可改成住户名。"),
        h("div", { className: "tel-list" }, sessions.map((session) => h("div", { className: "tel-row", key: session.sessionId },
          h("span", { className: "tel-code", style: { minWidth: 130 } }, shortId(session.sessionId)),
          h("input", {
            className: "tel-input",
            value: aliasOf(session),
            onChange: (event) => setAliasDraft((previous) => ({ ...previous, [session.sessionId]: event.target.value }))
          }),
          session.inPhonebook
            ? h(React.Fragment, null,
              h("label", { className: "tel-muted" },
                h("input", {
                  type: "checkbox",
                  checked: enabledOf(session),
                  onChange: (event) => setEnabledDraft((previous) => ({ ...previous, [session.sessionId]: event.target.checked }))
                }),
                " 启用"
              ),
              h("button", { className: "tel-btn tel-danger", type: "button", disabled: busy, onClick: () => removeFromPhonebook(session) }, "移出")
            )
            : h("button", { className: "tel-btn", type: "button", disabled: busy, onClick: () => addToPhonebook(session) }, "加入电话簿"),
          h("button", { className: "tel-btn", type: "button", disabled: busy, onClick: () => setQuota(session, session.quota + 1) }, "+ 配额")
        ))),
        h("div", { className: "tel-actions" },
          h("button", { className: "tel-btn", type: "button", disabled: busy, onClick: load }, "刷新"),
          h("button", { className: "tel-btn tel-primary", type: "button", disabled: busy, onClick: saveRoster }, "保存电话簿")
        )
      );

      return h("div", { className: "tel" },
        h("div", { className: "tel-head" },
          h("div", null,
            h("h3", { className: "tel-title" }, "电话总机"),
            h("div", { className: "tel-hint" }, "先把住户加入下方电话簿，再拖线连接；点线设置最大通话次数，点节点分配新建专线次数。")
          ),
          h("div", { className: "tel-actions" },
            h("label", {
              className: "tel-toggle",
              title: "关闭后，离线目标不会被 resume；电话会直接报错，请改走邮箱"
            },
              h("input", {
                type: "checkbox",
                checked: state.settings?.allowColdResume !== false,
                disabled: busy,
                onChange: toggleColdResume
              }),
              "离线可唤醒"
            ),
            h("button", {
              className: "tel-btn",
              type: "button",
              disabled: busy || graphSessions.filter((session) => enabledOf(session)).length < 2,
              onClick: connectAll,
              title: "只对已加入电话簿、已启用的会话生效；已有线保留原 max"
            }, "一键互拉"),
            h("button", {
              className: "tel-btn tel-danger",
              type: "button",
              disabled: busy || (links.length === 0 && activeLines.length === 0),
              onClick: clearAllLinks,
              title: "先挂断活跃专线，再删除所有电话线"
            }, "清空电话线"),
            h("button", { className: "tel-btn", type: "button", disabled: busy, onClick: load }, "刷新"),
            h("button", { className: "tel-btn tel-primary", type: "button", disabled: busy, onClick: saveRoster }, "保存电话簿")
          )
        ),
        error ? h("div", { className: "tel-err" }, error) : null,
        message ? h("div", { className: "tel-ok" }, message) : null,
        h("div", { className: "tel-panel" },
          h("div", { className: "tel-row" },
            h("span", { className: "tel-name" }, "连线"),
            h("span", { className: "tel-muted" }, `${links.length} 条 · 拖线新增；点击线条编辑`)
          ),
          graphSessions.length === 0
            ? h("div", { className: "tel-empty" }, "电话簿还是空的。展开下方「电话簿 / 住户映射」，把要打电话的会话加入。")
            : graph
        ),
        h("div", { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10 } },
          nodeDetail,
          edgeDetail || h("div", { className: "tel-panel tel-empty" }, "点一条线查看/修改最大通话次数。")
        ),
        activePanel,
        rosterPanel,
        h("div", { className: "tel-hint" },
          "规则：同一对住户只有一条活跃专线；第一次呼叫算 1 次；达到最大次数后专线结束；60 分钟无通话自动挂断；挂断/到上限只安静通知在线方。"
        )
      );
    }

    function apply(ctx) {
      ctx.effect(installStyle, "telephone: styles");
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register({
          name: "plugins.bundle.config",
          key: "dsh-telephone"
        }, Panel)
      );
    }

    return { inject: ["slots"], apply };
  }
});
