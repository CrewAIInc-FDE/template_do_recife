(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let channels = [];
  let activeChannelId = null;
  let eventSource = null;
  let isWaitingForReply = false;

  const renderedEventIds = new Set();
  const activeStreams = new Map();
  const closedCallIds = new Set();

  const ASSISTANT_LABEL = "Diário Oficial";
  const LOGO = "/static/img/logo_mark.jpg";

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------

  const $channelList      = document.getElementById("channel-list");
  const $emptyState       = document.getElementById("empty-state");
  const $chatView         = document.getElementById("chat-view");
  const $chatChannelName  = document.getElementById("chat-channel-name");
  const $messages         = document.getElementById("messages");
  const $typingIndicator  = document.getElementById("typing-indicator");
  const $messageForm      = document.getElementById("message-form");
  const $messageInput     = document.getElementById("message-input");
  const $btnNewChannel    = document.getElementById("btn-new-channel");
  const $modalOverlay     = document.getElementById("modal-overlay");
  const $newChannelForm   = document.getElementById("new-channel-form");
  const $newChannelName   = document.getElementById("new-channel-name");
  const $btnCancelModal   = document.getElementById("btn-cancel-modal");
  const $wakeupOverlay    = document.getElementById("wakeup-overlay");
  const $executionBanner  = document.getElementById("execution-banner");
  const $toolModalOverlay = document.getElementById("tool-modal-overlay");
  const $toolModalTitle   = document.getElementById("tool-modal-title");
  const $toolModalBody    = document.getElementById("tool-modal-body");
  const $btnCloseToolModal = document.getElementById("btn-close-tool-modal");

  // ---------------------------------------------------------------------------
  // API helpers
  // ---------------------------------------------------------------------------

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    if (opts.method === "DELETE" && res.status === 204) return null;
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // Channels
  // ---------------------------------------------------------------------------

  async function loadChannels() {
    channels = await api("/api/channels");
    renderChannelList();
  }

  function renderChannelList() {
    $channelList.innerHTML = "";
    channels.forEach((ch) => {
      const li = document.createElement("li");
      li.className = "channel-item" + (ch.id === activeChannelId ? " active" : "");
      li.dataset.id = ch.id;
      li.innerHTML =
        '<span class="hash">#</span>' +
        '<span class="channel-name">' + escapeHtml(ch.name) + "</span>" +
        '<button class="channel-delete" title="Excluir conversa" aria-label="Excluir conversa">' +
        '<span class="trash-icon" aria-hidden="true"></span></button>';
      li.addEventListener("click", () => selectChannel(ch.id));
      li.querySelector(".channel-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteChannel(ch.id);
      });
      $channelList.appendChild(li);
    });
  }

  function showMessageSkeleton() {
    $messages.querySelectorAll(".message, .skeleton-group, .tool-activity").forEach((el) => el.remove());
    const skeleton = document.createElement("div");
    skeleton.className = "skeleton-group";
    for (let i = 0; i < 4; i++) {
      skeleton.innerHTML += `
        <div class="skeleton-msg">
          <div class="skeleton-avatar skeleton-pulse"></div>
          <div class="skeleton-body">
            <div class="skeleton-line skeleton-line-name skeleton-pulse"></div>
            <div class="skeleton-line skeleton-pulse" style="width:${65 + Math.random() * 30}%"></div>
            <div class="skeleton-line skeleton-pulse" style="width:${40 + Math.random() * 35}%"></div>
          </div>
        </div>`;
    }
    $messages.insertBefore(skeleton, $typingIndicator);
  }

  function removeMessageSkeleton() {
    $messages.querySelectorAll(".skeleton-group").forEach((el) => el.remove());
  }

  async function selectChannel(channelId) {
    if (activeChannelId === channelId) return;
    activeChannelId = channelId;
    renderedEventIds.clear();
    activeStreams.forEach((s) => s.element?.remove());
    activeStreams.clear();
    closedCallIds.clear();
    renderChannelList();
    triggerWakeup();

    const known = channels.find((c) => c.id === channelId);
    $emptyState.classList.add("hidden");
    $chatView.classList.remove("hidden");
    $chatChannelName.textContent = known ? known.name : "";
    $messageInput.placeholder = known ? `Mensagem para #${known.name}` : "Mensagem…";
    $messageInput.disabled = true;
    showMessageSkeleton();

    const ch = await api(`/api/channels/${channelId}`);
    removeMessageSkeleton();
    $messageInput.disabled = false;

    if (!ch || ch.error) return;

    $chatChannelName.textContent = ch.name;
    $messageInput.placeholder = `Mensagem para #${ch.name}`;

    (ch.messages || []).forEach((msg) => renderMessage(msg));
    scrollToBottom();
    subscribeSSE(channelId);
    setTyping(false);
    setExecuting(false);
    $messageInput.focus();
  }

  // ---------------------------------------------------------------------------
  // SSE
  // ---------------------------------------------------------------------------

  function subscribeSSE(channelId) {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    eventSource = new EventSource(`/api/channels/${channelId}/events`);
    eventSource.onmessage = (e) => {
      if (channelId !== activeChannelId) return;
      try {
        const data = JSON.parse(e.data);
        handleSSEEvent(data);
      } catch (_) { /* ignore parse errors */ }
    };
    eventSource.onerror = () => {
      // Browser will auto-reconnect for us
    };
  }

  function handleSSEEvent(data) {
    if (data.type === "llm_stream_chunk") {
      handleStreamChunk(data);
    } else if (data.type === "tool_usage_started") {
      setTyping(false);
      createToolActivity(data.agent_role, data.tool_name);
      scrollToBottom();
    } else if (data.type === "tool_usage_finished") {
      handleToolUsageFinished(data);
    } else if (data.type === "kickoff_started" || data.type === "flow_started") {
      setTyping(true);
      setExecuting(true);
    } else if (data.type === "flow_finished") {
      handleFlowFinished(data);
    } else if (data.type === "kickoff_error") {
      finalizeAllStreams();
      setTyping(false);
      setExecuting(false);
      showError(data.error || "Falha ao iniciar a busca");
    }
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  function renderMessage(msg) {
    if (msg.role === "tool") return;
    if (msg.event_id) renderedEventIds.add(msg.event_id);

    if (msg.event_type === "tool_usage") {
      return renderToolUsageFromDB(msg);
    }

    const div = document.createElement("div");
    div.className = "message";

    const roleLabel = msg.role === "user" ? "Você" : ASSISTANT_LABEL;
    const isAssistant = msg.role === "assistant" || msg.role === "tool";
    const avatarHtml = isAssistant
      ? `<img src="${LOGO}" alt="${ASSISTANT_LABEL}" class="avatar-logo">`
      : "U";
    const ts = formatTimestamp(msg.timestamp);

    const contentHtml = `<div class="message-content">${renderContent(msg)}</div>`;

    div.innerHTML = `
      <div class="message-avatar ${msg.role}">${avatarHtml}</div>
      <div class="message-body">
        <div class="message-header">
          <span class="message-author ${msg.role}">${roleLabel}</span>
          <span class="message-timestamp">${ts}</span>
        </div>
        ${contentHtml}
      </div>
    `;

    $messages.insertBefore(div, $typingIndicator);
    return div;
  }

  function renderToolUsageFromDB(msg) {
    let duration_s = null;
    let toolArgs = null;
    let output = null;
    if (msg.timeline) {
      try {
        const t = JSON.parse(msg.timeline);
        duration_s = t.duration_s;
        toolArgs = t.tool_args;
        output = t.output;
      } catch (_) {}
    }
    const displayName = humanizeToolName(msg.content);
    const durationText = duration_s != null ? ` por ${Number(duration_s).toFixed(1)}s` : "";
    const div = document.createElement("div");
    div.className = "tool-activity done";
    div.dataset.tool = msg.content;
    div.innerHTML = `
      <img src="/static/img/tool.svg" class="tool-activity-icon" />
      <span class="tool-activity-text">Usou <strong>${escapeHtml(displayName)}</strong>${durationText}</span>
    `;
    attachToolDetails(div, {
      tool_name: msg.content,
      tool_args: toolArgs,
      output: output,
      duration_s: duration_s,
    });
    $messages.insertBefore(div, $typingIndicator);
    return div;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  function setTyping(show) {
    isWaitingForReply = show;
    $typingIndicator.classList.toggle("hidden", !show);
    if (show) scrollToBottom();
  }

  function setExecuting(show) {
    $executionBanner.classList.toggle("hidden", !show);
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  function setCursorOn(el) {
    if (!el) return;
    $messages.querySelectorAll(".cursor-active").forEach((e) => {
      if (e !== el) e.classList.remove("cursor-active");
    });
    el.classList.add("cursor-active");
  }

  function handleStreamChunk(data) {
    const { call_id, chunk, agent_role, seq } = data;
    if (!call_id || !chunk) return;

    // The execution already finished; ignore late / out-of-order chunks so
    // they don't reopen a finalized bubble with a stale cursor.
    if (closedCallIds.has(call_id)) return;

    const key = call_id;
    let stream = activeStreams.get(key);

    if (!stream) {
      setTyping(false);
      const el = createStreamingBubble(agent_role);
      const contentEl = el.querySelector(".message-content");
      stream = {
        element: el, contentEl,
        chunks: new Map(),
        fallbackSeq: 0,
        contentBuffer: "",
        wordCount: 0,
        agentRole: agent_role, callId: call_id,
        startTime: Date.now(),
      };
      activeStreams.set(key, stream);
    }

    setTyping(false);

    // Chunks can arrive out of order (realtime webhooks). Key them by
    // emission_sequence and always rebuild the text in sorted order; this
    // also dedupes any chunk that gets redelivered.
    const seqKey = (typeof seq === "number") ? seq : `f${stream.fallbackSeq++}`;
    if (stream.chunks.has(seqKey)) return;
    stream.chunks.set(seqKey, chunk);
    stream.contentBuffer = [...stream.chunks.entries()]
      .sort((a, b) => {
        const na = typeof a[0] === "number", nb = typeof b[0] === "number";
        if (na && nb) return a[0] - b[0];
        if (na) return -1;
        if (nb) return 1;
        return 0;
      })
      .map((e) => e[1])
      .join("");

    if (stream.contentEl && stream.contentBuffer) {
      stream.contentEl.innerHTML = marked.parse(stream.contentBuffer, { breaks: true });

      const walker = document.createTreeWalker(stream.contentEl, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      let wordIdx = 0;
      let newWordIdx = 0;

      for (const node of textNodes) {
        const text = node.textContent;
        if (!text) continue;

        const tokens = text.split(/(\s+)/);
        const fragment = document.createDocumentFragment();

        for (const token of tokens) {
          if (!token) continue;
          if (/^\s+$/.test(token)) {
            fragment.appendChild(document.createTextNode(token));
          } else {
            const span = document.createElement("span");
            if (wordIdx < stream.wordCount) {
              span.className = "stream-word-done";
            } else {
              span.className = "stream-word";
              span.style.animationDelay = `${newWordIdx * 25}ms`;
              newWordIdx++;
            }
            span.textContent = token;
            fragment.appendChild(span);
            wordIdx++;
          }
        }

        node.parentNode.replaceChild(fragment, node);
      }

      stream.wordCount = wordIdx;
      setCursorOn(stream.contentEl);
    }
    scrollToBottom();
  }

  function handleToolUsageFinished(data) {
    const el = document.querySelector(
      `.tool-activity[data-tool="${data.tool_name}"]:not(.done)`
    );
    if (el) {
      el.classList.add("done");
      const textEl = el.querySelector(".tool-activity-text");
      if (textEl) {
        textEl.innerHTML = `Usou <strong>${escapeHtml(humanizeToolName(data.tool_name))}</strong> por ${Number(data.duration_s).toFixed(1)}s`;
      }
      const spinner = el.querySelector(".tool-activity-spinner");
      if (spinner) spinner.remove();
      attachToolDetails(el, {
        tool_name: data.tool_name,
        tool_args: data.tool_args,
        output: data.output,
        duration_s: data.duration_s,
      });
    }
    scrollToBottom();
  }

  function createStreamingBubble(agentRole) {
    const div = document.createElement("div");
    div.className = "message";

    const avatarHtml = `<img src="${LOGO}" alt="${ASSISTANT_LABEL}" class="avatar-logo">`;
    const ts = formatTimestamp(new Date().toISOString());

    div.innerHTML = `
      <div class="message-avatar assistant">${avatarHtml}</div>
      <div class="message-body">
        <div class="message-header">
          <span class="message-author assistant">${ASSISTANT_LABEL}</span>
          <span class="message-timestamp">${ts}</span>
        </div>
        <div class="message-content streaming"></div>
      </div>
    `;

    $messages.insertBefore(div, $typingIndicator);
    return div;
  }

  function createToolActivity(agentRole, toolName) {
    const div = document.createElement("div");
    div.className = "tool-activity";
    div.dataset.tool = toolName;

    const displayName = humanizeToolName(toolName);
    div.innerHTML = `
      <img src="/static/img/tool.svg" class="tool-activity-icon" />
      <span class="tool-activity-text">Usando <strong>${escapeHtml(displayName)}</strong>...</span>
      <div class="tool-activity-spinner"><span></span><span></span><span></span></div>
    `;

    $messages.insertBefore(div, $typingIndicator);
    return div;
  }

  function handleFlowFinished(data) {
    // Streaming chunks arrive over realtime webhooks with no ordering or
    // delivery guarantees, so the live bubble may be incomplete. The server
    // sends the authoritative final text here; render it verbatim.
    if (data.call_id) closedCallIds.add(data.call_id);
    if (data.text) applyFinalText(data.call_id, data.text);
    finalizeAllStreams();
    setTyping(false);
    setExecuting(false);
  }

  function applyFinalText(callId, text) {
    let stream = (callId && activeStreams.get(callId)) || null;
    if (!stream) stream = activeStreams.values().next().value || null;

    let contentEl;
    if (stream && stream.contentEl) {
      contentEl = stream.contentEl;
    } else {
      const el = createStreamingBubble("");
      contentEl = el.querySelector(".message-content");
    }

    contentEl.innerHTML = marked.parse(text, { breaks: true });
    contentEl.style.display = "";
    contentEl.classList.remove("streaming", "cursor-active");
    scrollToBottom();
  }

  function finalizeAllStreams() {
    for (const [, stream] of activeStreams) {
      finalizeStream(stream);
    }
    activeStreams.clear();
    scrollToBottom();
  }

  function finalizeStream(stream) {
    if (stream.contentEl) {
      stream.contentEl.classList.remove("streaming", "cursor-active");
      if (!stream.contentBuffer) stream.contentEl.style.display = "none";
    }
  }

  function humanizeToolName(name) {
    if (!name) return "uma ferramenta";
    const map = {
      mongo_db_vector_search_tool: "Consulta ao Diário Oficial",
    };
    if (map[name]) return map[name];
    return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // ---------------------------------------------------------------------------
  // Tool execution detail modal
  // ---------------------------------------------------------------------------

  function attachToolDetails(el, details) {
    const hasInput = details.tool_args != null && Object.keys(details.tool_args || {}).length > 0;
    const hasOutput = details.output != null && String(details.output).length > 0;
    if (!hasInput && !hasOutput) return;

    el._toolDetails = details;
    el.classList.add("expandable");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.title = "Ver entrada e resultados da busca";

    if (!el.querySelector(".tool-activity-expand")) {
      const hint = document.createElement("span");
      hint.className = "tool-activity-expand";
      hint.textContent = "ver detalhes";
      el.appendChild(hint);
    }

    el.onclick = () => openToolModal(el._toolDetails);
    el.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openToolModal(el._toolDetails);
      }
    };
  }

  function parseMaybeJSON(value) {
    if (value == null) return null;
    if (typeof value === "object") return value;
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch (_) { return value; }
    }
    return value;
  }

  function getQueryText(toolArgs) {
    const args = parseMaybeJSON(toolArgs);
    if (args && typeof args === "object" && typeof args.query === "string") {
      return args.query;
    }
    return null;
  }

  function renderToolResults(output) {
    const parsed = parseMaybeJSON(output);

    if (!Array.isArray(parsed)) {
      const raw = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
      return `<pre class="tool-raw">${escapeHtml(raw || "")}</pre>`;
    }

    if (parsed.length === 0) {
      return `<p class="tool-empty">Nenhum resultado retornado.</p>`;
    }

    return parsed.map((item, i) => {
      const meta = item.metadata || {};
      const score = typeof item.score === "number" ? item.score.toFixed(3) : null;
      const parts = [];
      if (meta.do_issue_number) parts.push(`Edição nº ${escapeHtml(String(meta.do_issue_number))}`);
      if (meta.edition_date) parts.push(escapeHtml(String(meta.edition_date)));
      if (meta.page != null) {
        parts.push(`pág. ${escapeHtml(String(meta.page))}${meta.total_pages ? "/" + escapeHtml(String(meta.total_pages)) : ""}`);
      }
      const source = parts.join(" · ") || escapeHtml(meta.file_name || `Resultado ${i + 1}`);
      const text = (item.text || "").trim();

      return `
        <div class="tool-result">
          <div class="tool-result-head">
            <span class="tool-result-source">${source}</span>
            ${score != null ? `<span class="tool-result-score">score ${score}</span>` : ""}
          </div>
          ${meta.file_name ? `<div class="tool-result-file">${escapeHtml(meta.file_name)}</div>` : ""}
          <div class="tool-result-text">${escapeHtml(text)}</div>
        </div>`;
    }).join("");
  }

  function openToolModal(details) {
    if (!details) return;
    $toolModalTitle.textContent = humanizeToolName(details.tool_name);

    const query = getQueryText(details.tool_args);
    const argsObj = parseMaybeJSON(details.tool_args);
    const inputHtml = query != null
      ? `<p class="tool-query">${escapeHtml(query)}</p>`
      : `<pre class="tool-raw">${escapeHtml(argsObj ? JSON.stringify(argsObj, null, 2) : "—")}</pre>`;

    const durationText = details.duration_s != null
      ? ` <span class="tool-section-meta">${Number(details.duration_s).toFixed(1)}s</span>`
      : "";

    $toolModalBody.innerHTML = `
      <div class="tool-section">
        <h4>Entrada</h4>
        ${inputHtml}
      </div>
      <div class="tool-section">
        <h4>Resultados${durationText}</h4>
        <div class="tool-results">${renderToolResults(details.output)}</div>
      </div>
    `;

    $toolModalOverlay.classList.remove("hidden");
  }

  function closeToolModal() {
    $toolModalOverlay.classList.add("hidden");
  }

  $btnCloseToolModal.addEventListener("click", closeToolModal);
  $toolModalOverlay.addEventListener("click", (e) => {
    if (e.target === $toolModalOverlay) closeToolModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$toolModalOverlay.classList.contains("hidden")) {
      closeToolModal();
    }
  });

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------

  $messageForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = $messageInput.value.trim();
    if (!content || !activeChannelId) return;

    $messageInput.value = "";

    try {
      const result = await api(`/api/channels/${activeChannelId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      if (result && result.message) {
        renderMessage(result.message);
        scrollToBottom();
      }
      setTyping(true);
    } catch (err) {
      showError("Falha ao enviar a mensagem");
    }
  });

  // ---------------------------------------------------------------------------
  // New channel modal
  // ---------------------------------------------------------------------------

  $btnNewChannel.addEventListener("click", () => {
    $modalOverlay.classList.remove("hidden");
    $newChannelName.value = "";
    $newChannelName.focus();
  });

  $btnCancelModal.addEventListener("click", closeModal);
  $modalOverlay.addEventListener("click", (e) => {
    if (e.target === $modalOverlay) closeModal();
  });

  function closeModal() {
    $modalOverlay.classList.add("hidden");
  }

  $newChannelForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $newChannelName.value.trim();
    if (!name) return;

    closeModal();
    const ch = await api("/api/channels", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (ch && ch.id) {
      await loadChannels();
      selectChannel(ch.id);
    }
  });

  // ---------------------------------------------------------------------------
  // Delete channel
  // ---------------------------------------------------------------------------

  async function deleteChannel(channelId) {
    if (!confirm("Excluir esta conversa e todas as suas mensagens?")) return;

    await api(`/api/channels/${channelId}`, { method: "DELETE" });

    if (channelId === activeChannelId) {
      activeChannelId = null;
      if (eventSource) { eventSource.close(); eventSource = null; }
      $chatView.classList.add("hidden");
      $emptyState.classList.remove("hidden");
    }
    await loadChannels();
  }

  // ---------------------------------------------------------------------------
  // AMP wakeup
  // ---------------------------------------------------------------------------

  function triggerWakeup() {
    fetch("/api/wakeup", { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        if (data.status === "waking") {
          $wakeupOverlay.classList.remove("hidden", "fade-out");
        }
      })
      .catch(() => {})
      .finally(() => {
        $wakeupOverlay.classList.add("fade-out");
        setTimeout(() => $wakeupOverlay.classList.add("hidden"), 400);
      });
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function renderContent(msg) {
    if (!msg.content) return "";
    if (msg.role === "user") return escapeHtml(msg.content);
    return marked.parse(msg.content, { breaks: true });
  }

  function escapeHtml(str) {
    if (!str) return "";
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
  }

  function formatTimestamp(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts.includes("T") ? ts : ts + "Z");
      return d.toLocaleString("pt-BR", {
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch (_) {
      return ts;
    }
  }

  function showError(msg) {
    const el = document.createElement("div");
    el.className = "error-toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  triggerWakeup();
  loadChannels();
})();
