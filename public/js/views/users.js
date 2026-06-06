let users = [];
const usersView = document.getElementById('usersView');
import { ALL_ROLES } from '../roles.js';

function renderRoleMultiSelect(containerId, selectedRoles = []) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="multi-select" id="roleSelectWrapper">

      <div class="multi-select-display" id="roleSelectDisplay">
        ${
          selectedRoles.length
            ? selectedRoles.join(', ')
            : 'Rollen auswählen'
        }
        <span class="arrow">▼</span>
      </div>

      <div class="multi-select-dropdown hidden" id="roleSelectDropdown">
        ${ALL_ROLES.map(role => `
          <label>
            <input type="checkbox" value="${role}"
              ${selectedRoles.includes(role) ? 'checked' : ''}>
            ${role}
          </label>
        `).join('')}
      </div>

    </div>
  `;
}

export function renderUsersView(container, currentUser, mode = 'admin') {
  const isSelfView = mode === 'self';
  const isAdmin = currentUser.roles.includes('admin');
  if(!selectedUser || isSelfView) {
    selectedUser = currentUser;
  }

  container.innerHTML = `
    <h2>${isSelfView || !isAdmin ? 'Mein Profil' : 'Benutzerverwaltung'}</h2>

    ${!isSelfView && isAdmin ? `
      <div class="card">
        <h3>Benutzerprofile</h3>

        <div id="userList" class="user-list"></div>
        <div class="divider"></div>

        <div class="user-create-grid">
          <input id="newUsername" placeholder="Username">
          <input id="newPassword" type="password" placeholder="Passwort">
          <input id="newPassword2" type="password" placeholder="Passwort wiederholen">
          <button id="createUserBtn" class="primary">Benutzer erstellen</button>
        </div>
      </div>
    ` : ''}
  `;

  if (selectedUser) {

    const showRoles = isAdmin && !isSelfView && selectedUser.username !== 'admin';

    container.innerHTML += `
      <div class="card user-detail-card">
        <h3>Benutzer bearbeiten: ${selectedUser.username}</h3>

        <div class="form-grid">
          <input type="password" id="editPassword" placeholder="Neues Passwort">
          <input type="password" id="editPasswordRepeat" placeholder="Passwort wiederholen">
        </div>

        ${showRoles ? `
          <div class="form-group">
            <label class="form-label">Rollen</label>
            <div class="form-role" id="roleSelect"></div>
          </div>
        ` : ''}

        <div class="form-actions">
          <button id="saveUserChangesBtn" class="primary">Speichern</button>
        </div>

        <div id="userErrorBox" style="margin-top:10px;"></div>
      </div>
    `;
  }

  if (!isSelfView && isAdmin) {
    initUsersView();
  }

  if (
    selectedUser &&
    isAdmin &&
    !isSelfView &&
    selectedUser.username !== 'admin'
  ) {
    renderRoleMultiSelect('roleSelect', selectedUser.roles);
  }
}

export async function openOwnProfile(currentUser) {

  await fetchUsers();

  const user = users.find(u => u.username === currentUser.username);
  if (!user) return;

  renderUsersView(usersView, currentUser, 'self');
}


let selectedUser = null;
// Clickhandler
document.addEventListener('click', async (e) => {

  // 👉 User auswählen
  const card = e.target.closest('.user-row');
  if (card) {

    // Userbuttons herausfiltern
    if (
      e.target.closest('.switch') ||
      e.target.closest('.deleteUserBtn') ||
      e.target.closest('#roleSelectDropdown') ||
      e.target.closest('#roleSelectDisplay')
    ) {
      return;
    }

    const username = card.dataset.user;
    selectedUser = users.find(u => u.username === username);

    renderUsersView(usersView, window.currentUser, 'admin');
    return;
  }

  // 👉 Speichern
  const saveBtn = e.target.closest('#saveUserChangesBtn');
  if (saveBtn) {
    const password = document.getElementById('editPassword').value;
    const repeat = document.getElementById('editPasswordRepeat').value;

    const isAdmin = selectedUser.username === 'admin';

    // 🔥 Fehleranzeige vorbereiten
    let errorBox = document.getElementById('userErrorBox');
    if (!errorBox) {
      errorBox = document.createElement('div');
      errorBox.id = 'userErrorBox';
      errorBox.style.color = 'red';
      errorBox.style.marginTop = '10px';
      document.querySelector('.user-detail-card').appendChild(errorBox);
    }
    errorBox.innerText = '';

    // 🔥 Passwort prüfen (nur wenn gesetzt)
    if (password || repeat) {
      if (password !== repeat) {
        errorBox.innerText = 'Passwörter stimmen nicht überein';
        return;
      }
    }

    try {
      // 🔥 ADMIN → nur Passwort
      if (isAdmin) {
        await fetch(`/api/users/${selectedUser.username}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: password || undefined
          })
        });
      } else {
        // 🔥 Rollen sammeln
        const checked = document.querySelectorAll('#roleSelectDropdown input:checked');
        const roles = Array.from(checked).map(i => i.value);

        await fetch(`/api/users/${selectedUser.username}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: password || undefined,
            roles
          })
        });
      }

      // 🔥 Erfolg
      errorBox.style.color = 'green';
      errorBox.innerText = 'Gespeichert';

      loadUsers();

    } catch (err) {
      errorBox.innerText = 'Fehler beim Speichern';
    }

    return;
  }

  // 👉 Dropdown öffnen
  const display = e.target.closest('#roleSelectDisplay');
  if (display) {
    const dropdown = document.getElementById('roleSelectDropdown');
    if (!dropdown) return; // 🔥 verhindert crash

    dropdown.classList.toggle('hidden');
    return;
  }

  // 👉 Checkbox Änderung (Anzeige updaten)
  const roleCheckbox = e.target.closest('#roleSelectDropdown input');
  if (roleCheckbox) {
    const dropdown = document.getElementById('roleSelectDropdown');
    const display = document.getElementById('roleSelectDisplay');

    if (!dropdown || !display) return; // 🔥 wichtig

    const checked = dropdown.querySelectorAll('input:checked');
    const values = Array.from(checked).map(i => i.value);

    display.childNodes[0].textContent =
      values.length ? values.join(', ') : 'Rollen auswählen';

    return;
  }


});

async function initUsersView() {
  document.getElementById('createUserBtn')
    .addEventListener('click', createUser);

  loadUsers();
}

async function loadUsers() {
  await fetchUsers();

  const container = document.getElementById('userList');
  container.innerHTML = '';

  if (users.length === 0) {
    container.innerHTML = '<div style="color:#6b7280;">Keine Benutzer vorhanden</div>';
    return;
  }

  users.forEach(u => {
    const el = document.createElement('div');
    el.className = 'user-row';

    if (selectedUser && selectedUser.username === u.username) {
      el.classList.add('active');
    }
    el.dataset.user = u.username;

    const isDefaultAdmin = u.username === 'admin';
    const warningIcon = u.isDefault
      ? `<span class="admin-warning" title="Bitte Standard Passwort ändern">⚠️</span>`
      : '';

    el.innerHTML = `
      <div>
        <div class="user-name">
          ${u.username} ${warningIcon}
        </div>
        <span style="font-size:12px;color:#6b7280;">${u.roles}</span>
      </div>

      ${!isDefaultAdmin ? `
        <label class="switch">
          <input type="checkbox" ${u.active ? 'checked' : ''} data-user="${u.username}">
          <span class="slider">
            <span class="switch-label on">Aktiv</span>
            <span class="switch-label off">Inaktiv</span>
          </span>
        </label>
      ` : ''}

      ${!isDefaultAdmin ? `
        <button class="danger-btn deleteUserBtn" data-user="${u.username}">Entfernen</button>
      ` : ''}
    `;

    container.appendChild(el);
  });

    // Switch active
    document.querySelectorAll('.switch input').forEach(input => {
      input.addEventListener('change', async () => {
          const username = input.dataset.user;
          console.log(username);
          fetch(`/api/users/${username}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              active: input.checked
            })
          });
      });
    });

    // Edit
    document.querySelectorAll('.editUserBtn').forEach(btn => {
        btn.addEventListener('click', () => {
            const username = btn.dataset.user;
            openEditUserModal(username);
        });
    });

    // Abbrechen
    document.getElementById('closeUserModal')
    .addEventListener('click', () => {
        document.getElementById('userModal').classList.add('hidden');
        resetUserModal();
    });

    // Speichern
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

        const res = await fetch(`/api/users/${selectedUser.username}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            password: password || undefined,
            roles
          })
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

function renderUserDetailOnly() {

  usersView.innerHTML = `
    <h2>Mein Profil</h2>

    <div class="card user-detail-card">
      <h3>Benutzer bearbeiten: ${selectedUser.username}</h3>

      <div class="form-grid">
        <input type="password" id="editPassword" placeholder="Neues Passwort">
        <input type="password" id="editPasswordRepeat" placeholder="Passwort wiederholen">
      </div>

      <div class="form-actions">
        <button id="saveUserChangesBtn" class="primary">Speichern</button>
      </div>

      <div id="userErrorBox" style="margin-top:10px;"></div>
    </div>
  `;
}

async function fetchUsers() {
  const res = await fetch('/api/users');
  users = await res.json();
}