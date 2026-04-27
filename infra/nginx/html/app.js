(function () {
  const API_BASE = "/api/v1";
  const PRESENCE_HEARTBEAT_MS = 10000;
  const PRESENCE_POLL_MS = 5000;
  const MESSAGES_POLL_MS = 8000;

  const output = document.getElementById("output");
  const authStatus = document.getElementById("auth-status");
  const heartbeatStatus = document.getElementById("presence-heartbeat-status");
  const chatTitle = document.getElementById("chat-title");
  const chatSubtitle = document.getElementById("chat-subtitle");
  const messageFilesInput = document.getElementById("message-files");
  const selectedFilesLabel = document.getElementById("selected-files");

  let token = localStorage.getItem("groupsapp_token") || "";
  let userId = localStorage.getItem("groupsapp_user_id") || "";

  let heartbeatTimer = null;
  let presenceTimer = null;
  let messagesTimer = null;
  let pendingFiles = [];
  const deliveredAuto = new Set();
  const readAuto = new Set();

  const state = {
    contacts: [],
    groups: [],
    channelsByGroup: {},
    membersByGroup: {},
    messages: [],
    presenceByUser: {},
    selectedGroupId: null,
    selectedChannelId: null,
    selectedDmUserId: null
  };

  boot();

  function boot() {
    bindEvents();
    updateAuthStatus();
    renderSelectedFiles();

    if (token) {
      void bootstrapData();
      startHeartbeat();
      startPresencePolling();
      startMessagesPolling();
    }

    window.addEventListener("focus", () => {
      void autoMarkReadForVisibleMessages(state.messages || []);
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        void autoMarkReadForVisibleMessages(state.messages || []);
      }
    });
  }

  function log(title, data) {
    const text = `[${new Date().toLocaleTimeString()}] ${title}\n${JSON.stringify(data, null, 2)}\n\n`;
    output.textContent = text + output.textContent;
  }

  function updateAuthStatus() {
    authStatus.textContent = token
      ? `Autenticado | user_id=${userId || "(sin user_id)"}`
      : "No autenticado";
  }

  function updateHeartbeatStatus(text, statusClass) {
    heartbeatStatus.textContent = text;
    heartbeatStatus.className = "badge";
    if (statusClass) {
      heartbeatStatus.classList.add(statusClass);
    }
  }

  function getInputValue(id) {
    const el = document.getElementById(id);
    return (el && el.value ? el.value : "").trim();
  }

  function randomIdempotency(prefix) {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderSelectedFiles() {
    if (!selectedFilesLabel) {
      return;
    }
    if (!pendingFiles.length) {
      selectedFilesLabel.textContent = "Sin archivos seleccionados";
      return;
    }
    selectedFilesLabel.textContent = pendingFiles
      .map((file) => `${file.name} (${formatBytes(file.size)})`)
      .join(" · ");
  }

  async function uploadSelectedFiles() {
    if (!pendingFiles.length) {
      return [];
    }

    const uploadedAttachmentIds = [];
    for (const file of pendingFiles) {
      const uploadMeta = await api("/files/upload-url", {
        method: "POST",
        body: JSON.stringify({
          file_name: file.name,
          content_type: file.type || "application/octet-stream",
          size_bytes: file.size
        })
      });

      const uploadHeaders = Object.assign({}, uploadMeta.headers || {});
      if (!uploadHeaders["Content-Type"]) {
        uploadHeaders["Content-Type"] = file.type || "application/octet-stream";
      }

      const uploadResponse = await fetch(uploadMeta.upload_url, {
        method: uploadMeta.method || "PUT",
        headers: uploadHeaders,
        body: file
      });

      if (!uploadResponse.ok) {
        throw {
          status: uploadResponse.status,
          data: { message: `Falló la subida de ${file.name}` }
        };
      }

      const completed = await api(`/files/${encodeURIComponent(uploadMeta.attachment_id)}/complete`, {
        method: "POST"
      });

      uploadedAttachmentIds.push(completed.attachment_id);
    }

    return uploadedAttachmentIds;
  }

  function isCurrentUserAdminInSelectedGroup() {
    if (!state.selectedGroupId) {
      return false;
    }
    const members = state.membersByGroup[state.selectedGroupId] || [];
    const me = members.find((m) => m.user_id === userId);
    return !!me?.is_admin;
  }

  async function api(path, options = {}, includeAuth = true) {
    const headers = Object.assign({}, options.headers || {});
    if (includeAuth && token) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (!headers["Content-Type"] && options.body) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${API_BASE}${path}`, Object.assign({}, options, { headers }));
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      throw { status: res.status, data };
    }

    return data;
  }

  async function runAction(name, fn, silent) {
    try {
      const data = await fn();
      if (!silent) {
        log(`OK: ${name}`, data);
      }
      return data;
    } catch (err) {
      log(`ERROR: ${name}`, err);
      throw err;
    }
  }

  async function bootstrapData() {
    await refreshLists();
    await refreshCurrentMessages();
  }

  async function refreshLists() {
    if (!token) {
      return;
    }

    const [contactsRes, groupsRes] = await Promise.all([
      api("/users/contacts"),
      api("/groups")
    ]);

    state.contacts = contactsRes.items || [];
    state.groups = groupsRes.items || [];

    const selectedGroupStillExists =
      state.selectedGroupId && state.groups.some((g) => g.group_id === state.selectedGroupId);
    if (!selectedGroupStillExists) {
      state.selectedGroupId = state.groups[0]?.group_id || null;
      state.selectedChannelId = null;
    }

    if (state.selectedGroupId) {
      await loadGroupDetails(state.selectedGroupId);
    }

    await refreshContactsPresence();
    renderAll();
  }

  async function loadGroupDetails(groupId) {
    const [channelsRes, membersRes] = await Promise.all([
      api(`/groups/${encodeURIComponent(groupId)}/channels`),
      api(`/groups/${encodeURIComponent(groupId)}/members`)
    ]);

    state.channelsByGroup[groupId] = channelsRes.items || [];
    state.membersByGroup[groupId] = membersRes.items || [];

    const channels = state.channelsByGroup[groupId];
    const hasSelectedChannel = channels.some((c) => c.channel_id === state.selectedChannelId);
    if (!hasSelectedChannel) {
      state.selectedChannelId = channels[0]?.channel_id || null;
    }
  }

  async function refreshContactsPresence() {
    const presenceEntries = await Promise.all(
      state.contacts.map(async (contact) => {
        try {
          const p = await api(`/presence/${encodeURIComponent(contact.user_id)}`);
          return [contact.user_id, p];
        } catch {
          return [contact.user_id, { online: false }];
        }
      })
    );

    state.presenceByUser = Object.fromEntries(presenceEntries);
  }

  async function refreshCurrentMessages() {
    if (!token) {
      return;
    }

    if (state.selectedDmUserId) {
      const res = await api(`/messages/direct/${encodeURIComponent(state.selectedDmUserId)}?limit=50`);
      state.messages = res.items || [];
      void autoMarkDeliveredForVisibleMessages(state.messages);
      void autoMarkReadForVisibleMessages(state.messages);
      renderMessages();
      return;
    }

    if (state.selectedChannelId) {
      const res = await api(`/messages/channels/${encodeURIComponent(state.selectedChannelId)}?limit=50`);
      state.messages = res.items || [];
      void autoMarkDeliveredForVisibleMessages(state.messages);
      void autoMarkReadForVisibleMessages(state.messages);
      renderMessages();
      return;
    }

    state.messages = [];
    renderMessages();
  }

  async function autoMarkDeliveredForVisibleMessages(messages) {
    const incoming = (messages || []).filter((msg) => msg.sender_user_id !== userId);
    for (const msg of incoming) {
      void markReceiptOnce(msg.message_id, "delivered", deliveredAuto);
    }
  }

  async function autoMarkReadForVisibleMessages(messages) {
    if (document.hidden || !document.hasFocus()) {
      return;
    }

    const incoming = (messages || []).filter((msg) => msg.sender_user_id !== userId);
    for (const msg of incoming) {
      void markReceiptOnce(msg.message_id, "read", readAuto);
    }
  }

  async function markReceiptOnce(messageId, kind, cache) {
    if (!messageId || cache.has(messageId)) {
      return;
    }
    cache.add(messageId);
    try {
      await api(`/messages/${encodeURIComponent(messageId)}/${kind}`, {
        method: "POST"
      });
    } catch {
      cache.delete(messageId);
    }
  }

  function bindEvents() {
    document.getElementById("register-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const email = form.email.value.trim();
      const password = form.password.value;
      const displayName = form.display_name.value.trim();

      await runAction(
        "Register",
        () =>
          api(
            "/auth/register",
            {
              method: "POST",
              body: JSON.stringify({ email, password, display_name: displayName })
            },
            false
          ),
        false
      );
    });

    document.getElementById("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const email = form.email.value.trim();
      const password = form.password.value;

      const data = await runAction(
        "Login",
        () =>
          api(
            "/auth/login",
            {
              method: "POST",
              body: JSON.stringify({ email, password })
            },
            false
          ),
        false
      );

      token = data.access_token || "";
      userId = data.user_id || "";
      localStorage.setItem("groupsapp_token", token);
      localStorage.setItem("groupsapp_user_id", userId);

      updateAuthStatus();
      startHeartbeat();
      startPresencePolling();
      startMessagesPolling();
      await bootstrapData();
    });

    document.getElementById("logout").addEventListener("click", () => {
      logout();
      log("OK: Logout", { ok: true });
    });

    document.getElementById("refresh-all").addEventListener("click", async () => {
      await runAction("Refrescar listas", async () => {
        await refreshLists();
        await refreshCurrentMessages();
        return { ok: true };
      }, false);
    });

    document.getElementById("add-contact-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const contactUserId = getInputValue("contact-user-id");
      if (!contactUserId) {
        return;
      }

      await runAction(
        "AddContact",
        () =>
          api("/users/contacts", {
            method: "POST",
            body: JSON.stringify({ contact_user_id: contactUserId })
          }),
        false
      );

      document.getElementById("contact-user-id").value = "";
      await refreshLists();
    });

    document.getElementById("create-group-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = getInputValue("group-name");
      const description = getInputValue("group-description");
      if (!name) {
        return;
      }

      const data = await runAction(
        "CreateGroup",
        () =>
          api("/groups", {
            method: "POST",
            body: JSON.stringify({ name, description })
          }),
        false
      );

      document.getElementById("group-name").value = "";
      document.getElementById("group-description").value = "";

      state.selectedGroupId = data.group_id;
      state.selectedDmUserId = null;
      await refreshLists();
      await refreshCurrentMessages();
    });

    document.getElementById("create-channel-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.selectedGroupId) {
        log("WARN", { message: "Selecciona un grupo primero" });
        return;
      }
      if (!isCurrentUserAdminInSelectedGroup()) {
        log("WARN", { message: "Solo administradores pueden crear canales" });
        return;
      }

      const name = getInputValue("channel-name");
      const description = getInputValue("channel-description");
      if (!name) {
        return;
      }

      const data = await runAction(
        "CreateChannel",
        () =>
          api(`/groups/${encodeURIComponent(state.selectedGroupId)}/channels`, {
            method: "POST",
            body: JSON.stringify({ name, description })
          }),
        false
      );

      document.getElementById("channel-name").value = "";
      document.getElementById("channel-description").value = "";

      state.selectedChannelId = data.channel_id;
      state.selectedDmUserId = null;
      await refreshLists();
      await refreshCurrentMessages();
    });

    document.getElementById("add-member-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.selectedGroupId) {
        log("WARN", { message: "Selecciona un grupo" });
        return;
      }
      if (!isCurrentUserAdminInSelectedGroup()) {
        log("WARN", { message: "Solo administradores pueden agregar miembros" });
        return;
      }

      const memberUserId = document.getElementById("member-select").value;
      if (!memberUserId) {
        return;
      }

      await runAction(
        "AddMember",
        () =>
          api(`/groups/${encodeURIComponent(state.selectedGroupId)}/members`, {
            method: "POST",
            body: JSON.stringify({ member_user_id: memberUserId })
          }),
        false
      );

      await refreshLists();
    });

    if (messageFilesInput) {
      messageFilesInput.addEventListener("change", () => {
        pendingFiles = Array.from(messageFilesInput.files || []);
        renderSelectedFiles();
      });
    }

    document.getElementById("send-message-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const body = getInputValue("message-body");
        if (!body && !pendingFiles.length) {
          return;
        }

        const attachmentIds = await uploadSelectedFiles();

        if (state.selectedDmUserId) {
          await runAction(
            "SendDirectMessage",
            () =>
              api(`/messages/direct/${encodeURIComponent(state.selectedDmUserId)}`, {
                method: "POST",
                headers: { "Idempotency-Key": randomIdempotency("ui-dm") },
                body: JSON.stringify({ body, attachment_ids: attachmentIds })
              }),
            true
          );
        } else if (state.selectedChannelId) {
          await runAction(
            "SendChannelMessage",
            () =>
              api(`/messages/channels/${encodeURIComponent(state.selectedChannelId)}`, {
                method: "POST",
                headers: { "Idempotency-Key": randomIdempotency("ui-channel") },
                body: JSON.stringify({ body, attachment_ids: attachmentIds })
              }),
            true
          );
        } else {
          log("WARN", { message: "Selecciona un chat (canal o DM)" });
          return;
        }

        document.getElementById("message-body").value = "";
        pendingFiles = [];
        if (messageFilesInput) {
          messageFilesInput.value = "";
        }
        renderSelectedFiles();
        await refreshCurrentMessages();
      } catch (err) {
        log("ERROR: SendMessage", err);
      }
    });
  }

  async function sendHeartbeat(silent) {
    if (!token) {
      updateHeartbeatStatus("Heartbeat inactivo", "");
      return;
    }

    try {
      await api("/presence/heartbeat", { method: "POST" });
      updateHeartbeatStatus(`Heartbeat activo (${PRESENCE_HEARTBEAT_MS / 1000}s)`, "ok");
      if (!silent) {
        log("OK: Presence heartbeat", { every_seconds: PRESENCE_HEARTBEAT_MS / 1000 });
      }
    } catch (err) {
      if (err && err.status === 401) {
        logout();
        log("WARN: Presence heartbeat", { status: 401, detail: "Sesión expirada" });
        return;
      }
      updateHeartbeatStatus("Heartbeat con errores", "warn");
      if (!silent) {
        log("WARN: Presence heartbeat", err);
      }
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (!token) {
      updateHeartbeatStatus("Heartbeat inactivo", "");
      return;
    }

    void sendHeartbeat(false);
    heartbeatTimer = setInterval(() => {
      void sendHeartbeat(true);
    }, PRESENCE_HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startPresencePolling() {
    stopPresencePolling();
    if (!token) {
      return;
    }

    presenceTimer = setInterval(() => {
      void refreshContactsPresence().then(renderContacts).catch(() => undefined);
    }, PRESENCE_POLL_MS);
  }

  function stopPresencePolling() {
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
  }

  function startMessagesPolling() {
    stopMessagesPolling();
    if (!token) {
      return;
    }

    messagesTimer = setInterval(() => {
      void refreshCurrentMessages().catch(() => undefined);
    }, MESSAGES_POLL_MS);
  }

  function stopMessagesPolling() {
    if (messagesTimer) {
      clearInterval(messagesTimer);
      messagesTimer = null;
    }
  }

  function logout() {
    token = "";
    userId = "";
    localStorage.removeItem("groupsapp_token");
    localStorage.removeItem("groupsapp_user_id");

    stopHeartbeat();
    stopPresencePolling();
    stopMessagesPolling();

    state.contacts = [];
    state.groups = [];
    state.channelsByGroup = {};
    state.membersByGroup = {};
    state.messages = [];
    state.presenceByUser = {};
    state.selectedGroupId = null;
    state.selectedChannelId = null;
    state.selectedDmUserId = null;
    pendingFiles = [];
    deliveredAuto.clear();
    readAuto.clear();
    if (messageFilesInput) {
      messageFilesInput.value = "";
    }

    updateAuthStatus();
    updateHeartbeatStatus("Heartbeat inactivo", "");
    renderSelectedFiles();
    renderAll();
  }

  function renderAll() {
    renderContacts();
    renderGroups();
    renderRightPanel();
    renderChatHeader();
    renderMessages();
  }

  function renderContacts() {
    const el = document.getElementById("contacts-list");
    if (!token) {
      el.innerHTML = `<div class="muted">Inicia sesión para ver contactos</div>`;
      return;
    }

    if (!state.contacts.length) {
      el.innerHTML = `<div class="muted">No tienes contactos aún</div>`;
      return;
    }

    el.innerHTML = state.contacts
      .map((contact) => {
        const p = state.presenceByUser[contact.user_id] || { online: false };
        const isActiveDm = state.selectedDmUserId === contact.user_id;
        return `
          <article class="list-item ${isActiveDm ? "active" : ""}">
            <div class="item-title">
              <span><span class="presence-dot ${p.online ? "online" : ""}"></span>${escapeHtml(contact.display_name || "(sin nombre)")}</span>
            </div>
            <div class="item-subtitle">${escapeHtml(contact.email)} · ${escapeHtml(contact.user_id)}</div>
            <div class="item-actions">
              <button data-action="open-dm" data-user-id="${contact.user_id}">Abrir DM</button>
              <button data-action="block-user" data-user-id="${contact.user_id}">Bloquear</button>
            </div>
          </article>
        `;
      })
      .join("");

    el.querySelectorAll("button[data-action='open-dm']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.selectedDmUserId = btn.dataset.userId;
        state.selectedGroupId = null;
        state.selectedChannelId = null;
        renderAll();
        await refreshCurrentMessages();
      });
    });

    el.querySelectorAll("button[data-action='block-user']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const blockedUserId = btn.dataset.userId;
        await runAction(
          "BlockUser",
          () =>
            api("/users/blocks", {
              method: "POST",
              body: JSON.stringify({ blocked_user_id: blockedUserId })
            }),
          false
        );
        if (state.selectedDmUserId === blockedUserId) {
          state.selectedDmUserId = null;
        }
        await refreshLists();
        await refreshCurrentMessages();
      });
    });
  }

  function renderGroups() {
    const el = document.getElementById("groups-list");
    if (!token) {
      el.innerHTML = `<div class="muted">Inicia sesión para ver grupos</div>`;
      return;
    }

    if (!state.groups.length) {
      el.innerHTML = `<div class="muted">No perteneces a grupos</div>`;
      return;
    }

    el.innerHTML = state.groups
      .map((group) => {
        const isActive = state.selectedGroupId === group.group_id;
        return `
          <article class="list-item ${isActive ? "active" : ""}">
            <div class="item-title">${escapeHtml(group.name)}</div>
            <div class="item-subtitle">${escapeHtml(group.description || "Sin descripción")}</div>
            <div class="item-actions">
              <button data-action="open-group" data-group-id="${group.group_id}">Abrir</button>
              <button data-action="list-channels" data-group-id="${group.group_id}">Canales</button>
            </div>
          </article>
        `;
      })
      .join("");

    el.querySelectorAll("button[data-action='open-group']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const groupId = btn.dataset.groupId;
        state.selectedGroupId = groupId;
        state.selectedDmUserId = null;
        await loadGroupDetails(groupId);
        renderAll();
        await refreshCurrentMessages();
      });
    });

    el.querySelectorAll("button[data-action='list-channels']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const groupId = btn.dataset.groupId;
        state.selectedGroupId = groupId;
        state.selectedDmUserId = null;
        await loadGroupDetails(groupId);
        renderAll();
      });
    });
  }

  function renderRightPanel() {
    const selectedGroup = state.groups.find((g) => g.group_id === state.selectedGroupId);
    const groupLabel = document.getElementById("selected-group-label");
    const channelsEl = document.getElementById("channels-list");
    const membersEl = document.getElementById("members-list");
    const memberSelect = document.getElementById("member-select");

    if (!selectedGroup) {
      groupLabel.textContent = "Sin grupo seleccionado";
      channelsEl.innerHTML = `<div class="muted">Selecciona un grupo para ver canales</div>`;
      membersEl.innerHTML = `<div class="muted">Selecciona un grupo para ver miembros</div>`;
      memberSelect.innerHTML = `<option value="">Sin opciones</option>`;
      return;
    }

    groupLabel.textContent = `${selectedGroup.name} (${selectedGroup.group_id})`;

    const channels = state.channelsByGroup[selectedGroup.group_id] || [];
    const members = state.membersByGroup[selectedGroup.group_id] || [];
    const currentMember = members.find((m) => m.user_id === userId);
    const currentUserIsAdmin = !!currentMember?.is_admin;
    const addMemberButton = document.querySelector("#add-member-form button[type='submit']");
    const createChannelButton = document.querySelector("#create-channel-form button[type='submit']");
    channelsEl.innerHTML = channels.length
      ? channels
          .map((channel) => {
            const isActive = state.selectedChannelId === channel.channel_id && !state.selectedDmUserId;
            return `
              <article class="list-item ${isActive ? "active" : ""}">
                <div class="item-title"># ${escapeHtml(channel.name)}</div>
                <div class="item-subtitle">${escapeHtml(channel.description || "Sin descripción")}</div>
                <div class="item-actions">
                  <button data-action="open-channel" data-channel-id="${channel.channel_id}">Abrir chat</button>
                </div>
              </article>
            `;
          })
          .join("")
      : `<div class="muted">No hay canales aún</div>`;

    channelsEl.querySelectorAll("button[data-action='open-channel']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.selectedDmUserId = null;
        state.selectedChannelId = btn.dataset.channelId;
        renderAll();
        await refreshCurrentMessages();
      });
    });

    membersEl.innerHTML = members.length
      ? members
          .map((member) => {
            const canRemove = currentUserIsAdmin && member.user_id !== userId;
            return `
              <article class="list-item">
                <div class="item-title">${escapeHtml(member.display_name || "(sin nombre)")}${
                  member.is_admin ? " <span class='badge'>admin</span>" : ""
                }</div>
                <div class="item-subtitle">${escapeHtml(member.email)} · ${escapeHtml(member.user_id)}</div>
                <div class="item-actions">
                  ${
                    canRemove
                      ? `<button data-action="remove-member" data-user-id="${member.user_id}">Sacar</button>`
                      : ""
                  }
                </div>
              </article>
            `;
          })
          .join("")
      : `<div class="muted">No hay miembros</div>`;

    membersEl.querySelectorAll("button[data-action='remove-member']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!currentUserIsAdmin) {
          log("WARN", { message: "Solo administradores pueden sacar miembros" });
          return;
        }
        const memberUserId = btn.dataset.userId;
        await runAction(
          "RemoveMember",
          () =>
            api(`/groups/${encodeURIComponent(selectedGroup.group_id)}/members/${encodeURIComponent(memberUserId)}`, {
              method: "DELETE"
            }),
          false
        );

        await refreshLists();
      });
    });

    const memberIds = new Set(members.map((m) => m.user_id));
    const availableContacts = state.contacts.filter((c) => !memberIds.has(c.user_id));
    if (!currentUserIsAdmin) {
      memberSelect.disabled = true;
      memberSelect.innerHTML = `<option value="">Solo admins pueden agregar</option>`;
      if (addMemberButton) {
        addMemberButton.disabled = true;
      }
      if (createChannelButton) {
        createChannelButton.disabled = true;
      }
      return;
    }

    memberSelect.disabled = false;
    if (addMemberButton) {
      addMemberButton.disabled = false;
    }
    if (createChannelButton) {
      createChannelButton.disabled = false;
    }

    memberSelect.innerHTML = availableContacts.length
      ? availableContacts
          .map(
            (c) =>
              `<option value="${c.user_id}">${escapeHtml(c.display_name || c.email)} (${escapeHtml(c.email)})</option>`
          )
          .join("")
      : `<option value="">No hay contactos disponibles</option>`;
  }

  function renderChatHeader() {
    if (state.selectedDmUserId) {
      const contact = state.contacts.find((c) => c.user_id === state.selectedDmUserId);
      chatTitle.textContent = `DM · ${contact ? contact.display_name : state.selectedDmUserId}`;
      chatSubtitle.textContent = contact ? contact.email : state.selectedDmUserId;
      return;
    }

    if (state.selectedChannelId && state.selectedGroupId) {
      const channels = state.channelsByGroup[state.selectedGroupId] || [];
      const channel = channels.find((c) => c.channel_id === state.selectedChannelId);
      const group = state.groups.find((g) => g.group_id === state.selectedGroupId);
      chatTitle.textContent = `# ${channel ? channel.name : state.selectedChannelId}`;
      chatSubtitle.textContent = group ? `Grupo: ${group.name}` : "Canal de grupo";
      return;
    }

    chatTitle.textContent = "Selecciona un chat";
    chatSubtitle.textContent = "Elige un canal o contacto desde la izquierda";
  }

  function renderMessages() {
    const el = document.getElementById("messages-list");

    if (!state.messages.length) {
      el.innerHTML = `<div class="muted">Aún no hay mensajes en este chat</div>`;
      return;
    }

    const recipientsTotal = getRecipientsTotalForCurrentChat();

    el.innerHTML = state.messages
      .slice()
      .reverse()
      .map((msg) => {
        const mine = msg.sender_user_id === userId;
        const date = new Date(msg.created_at);
        const deliveredCount = Number(msg.delivered_count || 0);
        const readCount = Number(msg.read_count || 0);
        const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
        const safeDelivered = Math.max(0, Math.min(deliveredCount, recipientsTotal));
        const safeRead = Math.max(0, Math.min(readCount, recipientsTotal));
        const statusInfo = mine
          ? safeRead > 0
            ? {
                label: `Leído por ${safeRead}/${recipientsTotal}`,
                ticks: "✓✓",
                className: "read"
              }
            : safeDelivered > 0
              ? {
                  label: `Entregado a ${safeDelivered}/${recipientsTotal}`,
                  ticks: "✓✓",
                  className: "delivered"
                }
              : { label: `Enviado (0/${recipientsTotal})`, ticks: "✓", className: "sent" }
          : null;
        const attachmentsHtml = attachments.length
          ? `<div class="message-attachments">
              ${attachments
                .map((att) => {
                  const downloadUrl = att.download_url || "";
                  return `
                    <div class="message-attachment">
                      ${
                        downloadUrl
                          ? `<a href="${escapeHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(att.file_name || "archivo")}</a>`
                          : `<span>${escapeHtml(att.file_name || "archivo")}</span>`
                      }
                      <div class="item-subtitle">${escapeHtml(att.content_type || "")} · ${formatBytes(att.size_bytes || 0)}</div>
                    </div>
                  `;
                })
                .join("")}
            </div>`
          : "";
        return `
          <article class="message ${mine ? "mine" : ""}">
            <div class="message-meta">${escapeHtml(msg.sender_user_id)} · ${date.toLocaleString()}</div>
            <div class="message-body">${escapeHtml(msg.body)}</div>
            ${attachmentsHtml}
            ${
              mine && statusInfo
                ? `<div class="message-status ${statusInfo.className}"><span class="ticks">${statusInfo.ticks}</span> ${statusInfo.label}</div>`
                : ""
            }
          </article>
        `;
      })
      .join("");
  }

  function getRecipientsTotalForCurrentChat() {
    if (state.selectedDmUserId) {
      return 1;
    }

    if (state.selectedGroupId) {
      const members = state.membersByGroup[state.selectedGroupId] || [];
      const total = Math.max(members.length - 1, 1);
      return total;
    }

    return 1;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
