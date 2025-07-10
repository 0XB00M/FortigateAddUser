const express = require('express');
const SSH = require('ssh2-promise');
const bodyParser = require('body-parser');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const app = express();
const port = 3000;

// === Middleware ===
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', './views');

// === Session configuration ===
app.use(session({
  secret: 'your-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 60 * 1000 } // 30 minutes
}));

// === Authentication credentials ===
const AUTH_CREDENTIALS = {
  username: 'admin',
  password: 'admin123' // Change this in production
};

// === Multer config สำหรับอัปโหลด CSV ===
const upload = multer({ dest: 'uploads/' });

// === SSH config ===
const sshConfig = {
  host: '192.168.222.1',
  username: 'admin',
  password: '@1qaz2wsx'
};

// === Authentication middleware ===
function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/login');
  }
}

// === สร้างคำสั่งเพิ่ม user ===
function buildAddUserCommand(username, password) {
  return `
config user local
edit ${username}
set password ${password}
set accprofile super_admin
next
end
`;
}

// === ดึงรายชื่อผู้ใช้จาก FortiGate ===
async function getFortigateUsers() {
  const ssh = new SSH(sshConfig);
  const users = [];
  try {
    await ssh.connect();
    const output = await ssh.exec('show user local');
    const regex = /edit "([^"]+)"/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      if (match[1] !== 'admin') users.push(match[1]); // ไม่รวม admin
    }
  } catch (err) {
    console.error('SSH error:', err);
  } finally {
    ssh.close();
  }
  return users;
}

// === Login Routes ===
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === AUTH_CREDENTIALS.username && password === AUTH_CREDENTIALS.password) {
    req.session.authenticated = true;
    req.session.username = username;
    res.redirect('/');
  } else {
    res.render('login', { error: 'Invalid username or password' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destruction error:', err);
    }
    res.redirect('/login');
  });
});

// === หน้าเว็บหลัก ===
app.get('/', requireAuth, async (req, res) => {
  try {
    const users = await getFortigateUsers();
    res.render('index', { 
      users: users,
      username: req.session.username 
    });
  } catch (err) {
    res.status(500).render('error', { error: err.message });
  }
});

// === เพิ่มผู้ใช้เดี่ยว ===
app.post('/add', requireAuth, async (req, res) => {
  const { username, password } = req.body;
  const ssh = new SSH(sshConfig);
  try {
    await ssh.connect();
    await ssh.exec(buildAddUserCommand(username, password));
    res.render('success', { 
      message: `User <b>${username}</b> added successfully.`,
      backUrl: '/'
    });
  } catch (err) {
    res.status(500).render('error', { error: err.message });
  } finally {
    ssh.close();
  }
});

// === ลบผู้ใช้หลายคน ===
app.post('/delete-multiple', requireAuth, async (req, res) => {
  let { usernames } = req.body;
  if (!usernames) {
    return res.render('error', { error: 'No users selected.' });
  }

  if (!Array.isArray(usernames)) {
    usernames = [usernames];
  }

  const ssh = new SSH(sshConfig);
  try {
    await ssh.connect();
    for (const user of usernames) {
      const cmd = `
config user local
delete ${user}
end
`;
      await ssh.exec(cmd);
    }
    res.render('success', { 
      message: `✅ Deleted ${usernames.length} user(s).`,
      backUrl: '/'
    });
  } catch (err) {
    res.status(500).render('error', { error: err.message });
  } finally {
    ssh.close();
  }
});

// === เพิ่มจาก CSV ===
app.post('/upload-csv', requireAuth, upload.single('csvfile'), async (req, res) => {
  const filePath = req.file.path;
  const users = [];

  fs.createReadStream(filePath)
    .pipe(csv())
    .on('data', (row) => {
      console.log('CSV row:', row);
      const usernameKey = Object.keys(row).find(k => k.trim().toLowerCase() === 'username');
      const passwordKey = Object.keys(row).find(k => k.trim().toLowerCase() === 'password');

      if (usernameKey && passwordKey) {
        const username = row[usernameKey]?.trim();
        const password = row[passwordKey]?.trim();

        if (username && password) {
          users.push({ username, password });
        }
      }
    })
    .on('end', async () => {
      console.log('Parsed users:', users);
      const ssh = new SSH(sshConfig);
      try {
        await ssh.connect();
        for (const user of users) {
          const cmd = buildAddUserCommand(user.username, user.password);
          await ssh.exec(cmd);
        }
        res.render('success', { 
          message: `✅ ${users.length} users added from CSV.`,
          backUrl: '/'
        });
      } catch (err) {
        res.status(500).render('error', { error: err.message });
      } finally {
        ssh.close();
        fs.unlinkSync(filePath);
      }
    });
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});