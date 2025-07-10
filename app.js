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
  host: '192.168.214.1',
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
    throw new Error(getSSHErrorMessage(err));
  } finally {
    try {
      ssh.close();
    } catch (closeErr) {
      console.error('SSH close error:', closeErr);
    }
  }
  return users;
}

// === SSH Error Handler ===
function getSSHErrorMessage(err) {
  if (err.code === 'ECONNREFUSED') {
    return 'Connection refused. Please check if FortiGate is accessible and SSH is enabled.';
  } else if (err.code === 'ENOTFOUND') {
    return 'Host not found. Please check the FortiGate IP address.';
  } else if (err.code === 'ETIMEDOUT') {
    return 'Connection timeout. Please check network connectivity to FortiGate.';
  } else if (err.message && err.message.includes('Authentication failed')) {
    return 'SSH authentication failed. Please check username and password.';
  } else if (err.message && err.message.includes('Permission denied')) {
    return 'SSH permission denied. Please check credentials and user permissions.';
  } else if (err.message && err.message.includes('Host key verification failed')) {
    return 'SSH host key verification failed. Please check host key configuration.';
  } else if (err.code === 'ECONNRESET') {
    return 'Connection reset by FortiGate. Please check SSH configuration.';
  } else {
    return `SSH connection error: ${err.message}`;
  }
}

// === Test SSH Connection ===
async function testSSHConnection() {
  const ssh = new SSH(sshConfig);
  try {
    await ssh.connect();
    await ssh.exec('get system status');
    return { success: true, message: 'SSH connection successful' };
  } catch (err) {
    console.error('SSH connection test failed:', err);
    return { success: false, message: getSSHErrorMessage(err) };
  } finally {
    try {
      ssh.close();
    } catch (closeErr) {
      console.error('SSH close error:', closeErr);
    }
  }
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
      username: req.session.username,
      sshStatus: 'connected'
    });
  } catch (err) {
    console.error('Error loading dashboard:', err);
    res.render('index', { 
      users: [],
      username: req.session.username,
      sshStatus: 'disconnected',
      sshError: err.message
    });
  }
});

// === Test SSH Connection Route ===
app.get('/test-ssh', requireAuth, async (req, res) => {
  try {
    const result = await testSSHConnection();
    res.json(result);
  } catch (err) {
    res.json({ success: false, message: err.message });
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
    console.error('Error adding user:', err);
    res.render('error', { 
      error: `Failed to add user: ${getSSHErrorMessage(err)}` 
    });
  } finally {
    try {
      ssh.close();
    } catch (closeErr) {
      console.error('SSH close error:', closeErr);
    }
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
    console.error('Error deleting users:', err);
    res.render('error', { 
      error: `Failed to delete users: ${getSSHErrorMessage(err)}` 
    });
  } finally {
    try {
      ssh.close();
    } catch (closeErr) {
      console.error('SSH close error:', closeErr);
    }
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
      
      if (users.length === 0) {
        fs.unlinkSync(filePath);
        return res.render('error', { 
          error: 'No valid users found in CSV. Please check the format (username, password columns required).' 
        });
      }

      const ssh = new SSH(sshConfig);
      let successCount = 0;
      let errors = [];

      try {
        await ssh.connect();
        
        for (const user of users) {
          try {
            const cmd = buildAddUserCommand(user.username, user.password);
            await ssh.exec(cmd);
            successCount++;
          } catch (userErr) {
            console.error(`Error adding user ${user.username}:`, userErr);
            errors.push(`${user.username}: ${userErr.message}`);
          }
        }

        if (successCount > 0) {
          let message = `✅ Successfully added ${successCount} user(s) from CSV.`;
          if (errors.length > 0) {
            message += `<br><br>⚠️ ${errors.length} user(s) failed:<br>` + errors.join('<br>');
          }
          res.render('success', { 
            message: message,
            backUrl: '/'
          });
        } else {
          res.render('error', { 
            error: `Failed to add any users. Errors: ${errors.join(', ')}` 
          });
        }
      } catch (err) {
        console.error('SSH connection error during CSV upload:', err);
        res.render('error', { 
          error: `SSH connection failed: ${getSSHErrorMessage(err)}` 
        });
      } finally {
        try {
          ssh.close();
        } catch (closeErr) {
          console.error('SSH close error:', closeErr);
        }
        fs.unlinkSync(filePath);
      }
    })
    .on('error', (err) => {
      console.error('CSV parsing error:', err);
      fs.unlinkSync(filePath);
      res.render('error', { 
        error: `Failed to parse CSV file: ${err.message}` 
      });
    });
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});