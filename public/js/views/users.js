export function renderUsersView(container) {
    container.innerHTML = `
    <h2>Benutzer</h2>

    <div class="card">
        <h3>Benutzerverwaltung</h3>

        <!-- 🔥 USER LIST -->
        <div id="userList" class="user-list"></div>

        <!-- 🔥 TRENNER -->
        <div class="divider"></div>

        <!-- 🔥 CREATE USER -->
        <div class="user-create-grid">
        <input id="newUsername" placeholder="Username">
        <input id="newPassword" type="password" placeholder="Passwort">
        <input id="newPassword2" type="password" placeholder="Passwort wiederholen">
        <button id="createUserBtn" class="primary">Benutzer erstellen</button>
        </div>

    </div>
    `;

  initUsersView();
}

async function initUsersView() {
  document.getElementById('createUserBtn')
    .addEventListener('click', createUser);

  loadUsers();
}

async function loadUsers() {
  const res = await fetch('/api/users');
  const users = await res.json();

  const container = document.getElementById('userList');
  container.innerHTML = '';

  if (users.length === 0) {
    container.innerHTML = '<div style="color:#6b7280;">Keine Benutzer vorhanden</div>';
    return;
  }

  users.forEach(u => {
    const el = document.createElement('div');
    el.className = 'user-row';

    el.innerHTML = `
      <div>
        <b>${u.username}</b><br>
        <span style="font-size:12px;color:#6b7280;">${u.role}</span>
      </div>

    <label class="switch">
    <input type="checkbox" ${u.active ? 'checked' : ''} data-user="${u.username}">
    <span class="slider">
        <span class="switch-label on">Aktiv</span>
        <span class="switch-label off">Inaktiv</span>
    </span>
    </label>

      <button class="icon-btn editUserBtn" data-user="${u.username}">✏️</button>

      <button class="danger-btn deleteUserBtn" data-user="${u.username}">Entfernen</button>
    `;

    container.appendChild(el);
  });

    // Switch active
    document.querySelectorAll('.switch input').forEach(input => {
    input.addEventListener('change', async () => {
        const username = input.dataset.user;

        await fetch(`/api/users/${username}/toggle`, {
        method: 'PUT'
        });

        // optional: reloadUsers(); oder einfach lassen
    });
    });

    // Edit
    document.querySelectorAll('.editUserBtn').forEach(btn => {
        btn.addEventListener('click', () => {
            const username = btn.dataset.user;

            resetUserModal();

            document.getElementById('editUsername').value = username;
            document.getElementById('userModal').classList.remove('hidden');
        });
    });

    document.getElementById('closeUserModal')
    .addEventListener('click', () => {
        document.getElementById('userModal').classList.add('hidden');
        resetUserModal();
    });

    document.getElementById('saveUserBtn')
    .addEventListener('click', async () => {

        const username = document.getElementById('editUsername').value;
        const oldPassword = document.getElementById('editOldPassword').value;
        const newPassword = document.getElementById('editNewPassword').value;
        const newPassword2 = document.getElementById('editNewPassword2').value;

        if (newPassword !== newPassword2) {
        alert("Passwörter stimmen nicht überein");
        return;
        }

        const res = await fetch(`/api/users/${username}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword })
        });

        if (!res.ok) {
        alert("Fehler beim Ändern");
        return;
        }

        alert("Passwort geändert");

        document.getElementById('userModal').classList.add('hidden');
        resetUserModal();
    });

  // Delete
  document.querySelectorAll('.deleteUserBtn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.user;

      if (!confirm(`User ${username} löschen?`)) return;

      await fetch(`/api/users/${username}`, {
        method: 'DELETE'
      });

      loadUsers();
    });
  });
}

async function createUser() {
  const username = document.getElementById('newUsername').value;
  const password = document.getElementById('newPassword').value;
  const password2 = document.getElementById('newPassword2').value;

  if (!username || !password) {
    alert("Bitte alles ausfüllen");
    return;
  }

  if (password !== password2) {
    alert("Passwörter stimmen nicht überein");
    return;
  }

  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (!res.ok) {
    alert("Fehler beim Erstellen");
    return;
  }

  // Reset
  document.getElementById('newUsername').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('newPassword2').value = '';

  loadUsers();
}

function resetUserModal() {
  document.getElementById('editOldPassword').value = '';
  document.getElementById('editNewPassword').value = '';
  document.getElementById('editNewPassword2').value = '';
}