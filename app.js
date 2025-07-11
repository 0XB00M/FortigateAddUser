const express = require('express');
const SSH = require('ssh2-promise');
const bodyParser = require('body-parser');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const app = express();
const port = 5000;

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

// === SSH Connection Status ===
let sshConnectionStatus = {
  isConnected: false,
  lastError: null,
  lastChecked: null
};

// === Authentication middleware ===
function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.redirect('/login');
  }
}

// === Test SSH Connection ===
async function testSSHConnection() {
  const ssh = new SSH(sshConfig);
  try {
    await ssh.connect();
    await ssh.exec('get system status');
    sshConnectionStatus = {
      isConnected: true,
      lastError: null,
      lastChecked: new Date()
    };
    return true;
  } catch (err) {
    sshConnectionStatus = {
      isConnected: false,
      lastError: err.message,
      lastChecked: new Date()
    };
    console.error('SSH Connection Test Failed:', err.message);
    return false;
  } finally {
    ssh.close();
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
    
    // Update connection status on successful operation
    sshConnectionStatus.isConnected = true;
    sshConnectionStatus.lastError = null;
    sshConnectionStatus.lastChecked = new Date();
    
  } catch (err) {
    console.error('SSH error:', err);
    sshConnectionStatus = {
      isConnected: false,
      lastError: err.message,
      lastChecked: new Date()
    };
    throw err; // Re-throw to be handled by calling function
  } finally {
    ssh.close();
  }
  return users;
}

// === Login Routes ===
app.get('/login', (req, res) => {
  res.render('login', { 
    error: null,
    sshStatus: sshConnectionStatus 
  });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (username === AUTH_CREDENTIALS.username && password === AUTH_CREDENTIALS.password) {
    // Test SSH connection after successful login
    await testSSHConnection();
    
    req.session.authenticated = true;
    req.session.username = username;
    res.redirect('/');
  } else {
    res.render('login', { 
      error: 'Invalid username or password',
      sshStatus: sshConnectionStatus 
    });
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
      sshStatus: sshConnectionStatus,
      error: null
    });
  } catch (err) {
    // Handle SSH connection errors gracefully
    res.render('index', { 
      users: [],
      username: req.session.username,
      sshStatus: sshConnectionStatus,
      error: 'Unable to connect to FortiGate device. Please check the connection.'
    });
  }
});

// === Test SSH Connection Route ===
app.get('/test-ssh', requireAuth, async (req, res) => {
  const isConnected = await testSSHConnection();
  res.json({
    success: isConnected,
    status: sshConnectionStatus
  });
});

// === เพิ่มผู้ใช้เดี่ยว ===
app.post('/add', requireAuth, async (req, res) => {
  const { username, password } = req.body;
  const ssh = new SSH(sshConfig);
  try {
    await ssh.connect();
    await ssh.exec(buildAddUserCommand(username, password));
    
    // Update connection status on successful operation
    sshConnectionStatus.isConnected = true;
    sshConnectionStatus.lastError = null;
    sshConnectionStatus.lastChecked = new Date();
    
    res.render('success', { 
      message: `User <b>${username}</b> added successfully.`,
      backUrl: '/',
      sshStatus: sshConnectionStatus
    });
  } catch (err) {
    sshConnectionStatus = {
      isConnected: false,
      lastError: err.message,
      lastChecked: new Date()
    };
    res.status(500).render('error', { 
      error: `Failed to add user: ${err.message}`,
      sshStatus: sshConnectionStatus
    });
  } finally {
    ssh.close();
  }
});

// === ลบผู้ใช้หลายคน ===
app.post('/delete-multiple', requireAuth, async (req, res) => {
  console.log('Delete request body:', req.body); // Debug log
  
  let { usernames } = req.body;
  
  // Check if usernames exists and is not empty
  if (!usernames || (Array.isArray(usernames) && usernames.length === 0)) {
    return res.status(400).render('error', { 
      error: 'No users selected for deletion.',
      sshStatus: { isConnected: false, lastError: null, lastChecked: null }
    });
  }

  // Ensure usernames is always an array
  if (!Array.isArray(usernames)) {
    usernames = [usernames];
  }

  // Filter out empty values
  usernames = usernames.filter(user => user && user.trim() !== '');
  
  if (usernames.length === 0) {
    return res.status(400).render('error', { 
      error: 'No valid users selected for deletion.',
      sshStatus: { isConnected: false, lastError: null, lastChecked: null }
    });
  }

  console.log('Processing deletion for users:', usernames); // Debug log

  const ssh = new SSH(sshConfig);
  let sshStatus = { isConnected: false, lastError: null, lastChecked: new Date() };
  
  try {
    // Test SSH connection first
    await ssh.connect();
    sshStatus.isConnected = true;
    
    // Delete each user
    for (const user of usernames) {
      const cmd = `
config user local
delete ${user.trim()}
end
`;
      console.log(`Executing delete command for user: ${user}`); // Debug log
      await ssh.exec(cmd);
    }
    
    // Success response
    res.render('success', { 
      message: `✅ Successfully deleted ${usernames.length} user(s): ${usernames.join(', ')}`,
      backUrl: '/'
    });
    
  } catch (err) {
    console.error('SSH error during deletion:', err); // Debug log
    sshStatus.lastError = err.message;
    
    res.status(500).render('error', { 
      error: `Failed to delete users: ${err.message}`,
      sshStatus: sshStatus
    });
  } finally {
    if (ssh) {
      ssh.close();
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
      const ssh = new SSH(sshConfig);
      try {
        await ssh.connect();
        for (const user of users) {
          const cmd = buildAddUserCommand(user.username, user.password);
          await ssh.exec(cmd);
        }
        
        // Update connection status on successful operation
        sshConnectionStatus.isConnected = true;
        sshConnectionStatus.lastError = null;
        sshConnectionStatus.lastChecked = new Date();
        
        res.render('success', { 
          message: `✅ ${users.length} users added from CSV.`,
          backUrl: '/',
          sshStatus: sshConnectionStatus
        });
      } catch (err) {
        sshConnectionStatus = {
          isConnected: false,
          lastError: err.message,
          lastChecked: new Date()
        };
        res.status(500).render('error', { 
          error: `Failed to add users from CSV: ${err.message}`,
          sshStatus: sshConnectionStatus
        });
      } finally {
        ssh.close();
        fs.unlinkSync(filePath);
      }
    });
});

// Test SSH connection on startup
testSSHConnection().then(() => {
  console.log('Initial SSH connection test completed');
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});