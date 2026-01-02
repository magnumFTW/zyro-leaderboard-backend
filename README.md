Leaderboard Backend API
Backend service for managing a 30-day competition leaderboard with admin controls.
Features

✅ Public leaderboard endpoint (proxies external API)
✅ Admin-protected timer controls
✅ 30-day competition timer management
✅ Dynamic date range filtering
✅ CORS enabled
✅ In-memory state storage (easy to migrate to database)


Quick Start
1. Installation
bash# Clone or create project directory
mkdir leaderboard-backend
cd leaderboard-backend

# Initialize npm (if package.json doesn't exist)
npm init -y

# Install dependencies
npm install express axios dotenv cors

# Install dev dependencies (optional)
npm install --save-dev nodemon
2. Project Structure
leaderboard-backend/
├── src/
│   └── index.js          # Main server file
├── .env                  # Environment variables (create this)
├── .gitignore           # Git ignore rules
├── package.json         # Dependencies
└── README.md            # This file
3. Create .env File
bash# Copy and paste into .env file
PORT=3000
NODE_ENV=development
ADMIN_API_KEY=your-super-secret-admin-key-change-this
FRONTEND_URL=http://localhost:8080
Generate a secure admin key:
bashnode -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
4. Run the Server
bash# Production
npm start

# Development (auto-restart on changes)
npm run dev

API Documentation
Base URL
http://localhost:3000/api

Public Endpoints
1. Get Leaderboard Data
Endpoint: GET /api/leaderboard
Description: Fetches leaderboard data from external API with dynamic date filtering based on active competition.
Response:
json{
  "success": true,
  "data": {
    "totalCount": 22,
    "filteredCount": 10,
    "list": [
      {
        "user": {
          "id": 684337,
          "username": "TheYiffPlug",
          "avatarUrl": "https://...",
          "level": 45,
          "levelTier": "GOLD"
        },
        "earned": "10.05293",
        "wagered": "2261.86",
        "totalDeposit": "282.00000",
        "active": true,
        "firstDepositor": true
      }
    ]
  },
  "competition": {
    "isActive": true,
    "isEnded": false,
    "startTime": "2025-01-02T10:00:00.000Z",
    "endTime": "2025-02-01T10:00:00.000Z",
    "remainingSeconds": 2592000
  },
  "fetchedAt": "2025-01-02T10:00:00.000Z"
}
Date Range Logic:

Active competition: Filters data from startTime to endTime
No competition: Returns all-time data (2024-01-01 to 2099-12-31)


2. Get Competition Status
Endpoint: GET /api/status
Description: Returns current competition status (public, no authentication).
Response:
json{
  "success": true,
  "competition": {
    "isActive": true,
    "isEnded": false,
    "startTime": "2025-01-02T10:00:00.000Z",
    "endTime": "2025-02-01T10:00:00.000Z",
    "remainingSeconds": 2592000,
    "durationDays": 30
  },
  "serverTime": "2025-01-02T10:00:00.000Z"
}

3. Health Check
Endpoint: GET /api/health
Description: Server health check for monitoring.
Response:
json{
  "success": true,
  "status": "healthy",
  "timestamp": "2025-01-02T10:00:00.000Z",
  "uptime": 3600.5,
  "memory": {
    "rss": 50331648,
    "heapTotal": 20971520,
    "heapUsed": 10485760
  },
  "version": "1.0.0"
}

Admin Endpoints (Protected)
Authentication: All admin endpoints require the X-API-Key header.
bashX-API-Key: your-super-secret-admin-key

1. Start Competition
Endpoint: POST /api/admin/start
Description: Starts a new 30-day competition timer.
Headers:
X-API-Key: your-admin-key
Content-Type: application/json
Request Body (optional):
json{
  "durationDays": 30
}
Response (Success):
json{
  "success": true,
  "message": "Competition started successfully (30 days)",
  "competition": {
    "isActive": true,
    "startTime": "2025-01-02T10:00:00.000Z",
    "endTime": "2025-02-01T10:00:00.000Z",
    "isEnded": false,
    "createdAt": "2025-01-02T10:00:00.000Z",
    "durationDays": 30,
    "remainingSeconds": 2592000
  }
}
Response (Already Active):
json{
  "success": false,
  "message": "Competition is already active",
  "currentState": {
    "startTime": "2025-01-02T10:00:00.000Z",
    "endTime": "2025-02-01T10:00:00.000Z",
    "remainingSeconds": 2592000
  }
}
cURL Example:
bashcurl -X POST http://localhost:3000/api/admin/start \
  -H "X-API-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"durationDays": 30}'

2. Reset Competition
Endpoint: POST /api/admin/reset
Description: Resets the competition timer and clears all state.
Headers:
X-API-Key: your-admin-key
Response:
json{
  "success": true,
  "message": "Competition reset successfully",
  "previousState": {
    "isActive": true,
    "startTime": "2025-01-02T10:00:00.000Z",
    "endTime": "2025-02-01T10:00:00.000Z",
    "isEnded": false
  },
  "newState": {
    "isActive": false,
    "startTime": null,
    "endTime": null,
    "isEnded": false,
    "createdAt": null
  }
}
cURL Example:
bashcurl -X POST http://localhost:3000/api/admin/reset \
  -H "X-API-Key: your-admin-key"

3. Get Admin Status
Endpoint: GET /api/admin/status
Description: Returns detailed competition status (admin view with extra metadata).
Headers:
X-API-Key: your-admin-key
Response:
json{
  "success": true,
  "competition": {
    "isActive": true,
    "isEnded": false,
    "startTime": "2025-01-02T10:00:00.000Z",
    "endTime": "2025-02-01T10:00:00.000Z",
    "createdAt": "2025-01-02T10:00:00.000Z",
    "remainingSeconds": 2592000,
    "remainingDays": 30,
    "durationDays": 30
  },
  "serverTime": "2025-01-02T10:00:00.000Z",
  "uptime": 3600.5
}
cURL Example:
bashcurl http://localhost:3000/api/admin/status \
  -H "X-API-Key: your-admin-key"

Error Responses
401 Unauthorized
json{
  "success": false,
  "message": "Authentication required. Provide X-API-Key header."
}
403 Forbidden
json{
  "success": false,
  "message": "Invalid API key. Access denied."
}
404 Not Found
json{
  "success": false,
  "message": "Endpoint not found",
  "path": "/api/unknown"
}
500 Internal Server Error
json{
  "success": false,
  "message": "Failed to fetch leaderboard data",
  "error": "Connection timeout"
}

Frontend Integration Example
JavaScript (Fetch API)
javascript// Public endpoint - no auth required
async function getLeaderboard() {
  const response = await fetch('http://localhost:3000/api/leaderboard');
  const data = await response.json();
  
  if (data.success) {
    console.log('Leaderboard:', data.data);
    console.log('Competition:', data.competition);
  }
}

// Admin endpoint - requires API key
async function startCompetition() {
  const response = await fetch('http://localhost:3000/api/admin/start', {
    method: 'POST',
    headers: {
      'X-API-Key': 'your-admin-key',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ durationDays: 30 })
  });
  
  const data = await response.json();
  console.log(data);
}
Axios Example
javascriptconst axios = require('axios');

// Get leaderboard
const leaderboard = await axios.get('http://localhost:3000/api/leaderboard');
console.log(leaderboard.data);

// Start competition (admin)
const result = await axios.post(
  'http://localhost:3000/api/admin/start',
  { durationDays: 30 },
  { headers: { 'X-API-Key': 'your-admin-key' } }
);
console.log(result.data);

Security Notes
⚠️ Important

Change the default admin key in .env
Never commit .env to version control
Use HTTPS in production (not HTTP)
Consider JWT tokens for more advanced auth
Add rate limiting in production (use express-rate-limit)
Use a database instead of in-memory storage for persistence

Production Checklist

 Set secure ADMIN_API_KEY in .env
 Set NODE_ENV=production
 Enable HTTPS with SSL certificate
 Add rate limiting middleware
 Replace in-memory storage with Redis/database
 Set up monitoring and logging
 Configure firewall rules
 Enable CORS only for trusted domains


Deployment
Deploy to VPS (DigitalOcean, AWS, etc.)
bash# 1. SSH into your server
ssh user@your-server-ip

# 2. Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Clone your code
git clone your-repo-url
cd leaderboard-backend

# 4. Install dependencies
npm install --production

# 5. Create .env file
nano .env
# Add your environment variables

# 6. Install PM2 (process manager)
sudo npm install -g pm2

# 7. Start server with PM2
pm2 start src/index.js --name leaderboard-api
pm2 save
pm2 startup

# 8. Check status
pm2 status
pm2 logs leaderboard-api
Deploy to Heroku
bash# 1. Install Heroku CLI
# https://devcenter.heroku.com/articles/heroku-cli

# 2. Login
heroku login

# 3. Create app
heroku create leaderboard-api

# 4. Set environment variables
heroku config:set ADMIN_API_KEY=your-secret-key
heroku config:set NODE_ENV=production

# 5. Deploy
git push heroku main

# 6. View logs
heroku logs --tail

Testing with cURL
Test Public Endpoints
bash# Get leaderboard
curl http://localhost:3000/api/leaderboard

# Get status
curl http://localhost:3000/api/status

# Health check
curl http://localhost:3000/api/health
Test Admin Endpoints
bash# Start competition
curl -X POST http://localhost:3000/api/admin/start \
  -H "X-API-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"durationDays": 30}'

# Get admin status
curl http://localhost:3000/api/admin/status \
  -H "X-API-Key: your-admin-key"

# Reset competition
curl -X POST http://localhost:3000/api/admin/reset \
  -H "X-API-Key: your-admin-key"

Troubleshooting
Port Already in Use
bash# Find process using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or change PORT in .env
PORT=3001
CORS Errors
Add your frontend URL to .env:
FRONTEND_URL=http://localhost:8080
Or modify CORS config in src/index.js:
javascriptapp.use(cors({
    origin: ['http://localhost:8080', 'https://yourdomain.com']
}));
External API Errors
Check if the external API is accessible:
bashcurl "https://api.skinrave.gg/affiliates/public/applicants?token=35eb5f92-aa7a-4e53-80eb-b8efce4b70fe&skip=0&take=10&order=DESC&from=2024-01-01T00:00:00Z&to=2025-12-31T23:59:59Z"

License
MIT
Support
For issues or questions, please open an issue on the repository.