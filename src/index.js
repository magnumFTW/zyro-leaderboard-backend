/* ===================================================================
 * LEADERBOARD BACKEND API - VERCEL DEPLOYMENT VERSION
 * 
 * FIXED: CORS configured for Vercel deployment
 * ================================================================ */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// ===================================================================
// # CONFIGURATION
// ===================================================================
const CONFIG = {
    EXTERNAL_API_BASE: 'https://api.skinrave.gg/affiliates/public/applicants',
    EXTERNAL_API_TOKEN: '35eb5f92-aa7a-4e53-80eb-b8efce4b70fe',
    COMPETITION_DURATION_DAYS: 30,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || 'change-me-in-production',
    MAX_RECORDS_PER_REQUEST: 30
};

// ===================================================================
// # IN-MEMORY STATE STORAGE
// ===================================================================
let competitionState = {
    isActive: false,
    startTime: null,
    endTime: null,
    isEnded: false,
    createdAt: null
};

// ===================================================================
// # MIDDLEWARE - FIXED CORS FOR VERCEL
// ===================================================================

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);
        
        // If running on Vercel, allow all origins
        if (process.env.VERCEL || process.env.VERCEL_ENV) {
            return callback(null, true);
        }
        
        // Local development allowed origins
        const allowedOrigins = [
            'http://127.0.0.1:5500',
            'http://localhost:5500',
            'http://127.0.0.1:8080',
            'http://localhost:8080',
            'http://localhost:3000',
            process.env.FRONTEND_URL
        ].filter(Boolean);
        
        if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV === 'development') {
            return callback(null, true);
        }
        
        // Default: allow the request
        callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

app.use(express.json());

app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// ===================================================================
// # AUTHENTICATION MIDDLEWARE
// ===================================================================

function authenticateAdmin(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required. Provide X-API-Key header.'
        });
    }
    
    if (apiKey !== CONFIG.ADMIN_API_KEY) {
        return res.status(403).json({
            success: false,
            message: 'Invalid API key. Access denied.'
        });
    }
    
    next();
}

// ===================================================================
// # UTILITY FUNCTIONS
// ===================================================================

function calculateRemainingSeconds(endTimeISO) {
    if (!endTimeISO) return 0;
    
    const now = new Date().getTime();
    const end = new Date(endTimeISO).getTime();
    const diffMs = end - now;
    
    return Math.max(0, Math.floor(diffMs / 1000));
}

function checkAndUpdateCompetitionStatus() {
    if (!competitionState.isActive) return;
    
    const remaining = calculateRemainingSeconds(competitionState.endTime);
    
    if (remaining === 0 && !competitionState.isEnded) {
        competitionState.isEnded = true;
        competitionState.isActive = false;
        
        console.log('🏁 Competition has ended automatically');
        console.log(`   Frozen snapshot: ${competitionState.startTime} to ${competitionState.endTime}`);
    }
}

function getCompetitionDateRange() {
    // CASE 1: Competition is ACTIVE
    if (competitionState.isActive && !competitionState.isEnded && competitionState.startTime && competitionState.endTime) {
        const now = new Date();
        const competitionEnd = new Date(competitionState.endTime);
        const effectiveTo = now < competitionEnd ? now : competitionEnd;
        
        console.log('📅 Active competition:');
        console.log(`   From: ${competitionState.startTime} (start)`);
        console.log(`   To: ${effectiveTo.toISOString()} (${now < competitionEnd ? 'now' : 'end'})`);
        
        return {
            from: competitionState.startTime,
            to: effectiveTo.toISOString()
        };
    }
    
    // CASE 2: Competition has ENDED
    if (competitionState.isEnded && competitionState.startTime && competitionState.endTime) {
        console.log('📅 Ended competition (FROZEN):');
        console.log(`   From: ${competitionState.startTime} (start)`);
        console.log(`   To: ${competitionState.endTime} (end - LOCKED)`);
        
        return {
            from: competitionState.startTime,
            to: competitionState.endTime
        };
    }
    
    // CASE 3: No competition
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
    
    console.log('📅 No competition - showing last 30 days');
    console.log(`   From: ${thirtyDaysAgo.toISOString()}`);
    console.log(`   To: ${now.toISOString()}`);
    
    return {
        from: thirtyDaysAgo.toISOString(),
        to: now.toISOString()
    };
}

// ===================================================================
// # PUBLIC ROUTES
// ===================================================================

app.get('/api/leaderboard', async (req, res) => {
    try {
        checkAndUpdateCompetitionStatus();
        
        const { from, to } = getCompetitionDateRange();
        
        const apiUrl = `${CONFIG.EXTERNAL_API_BASE}` +
            `?token=${CONFIG.EXTERNAL_API_TOKEN}` +
            `&skip=0` +
            `&take=${CONFIG.MAX_RECORDS_PER_REQUEST}` +
            `&order=DESC` +
            `&from=${from}` +
            `&to=${to}`;
        
        console.log(`📊 Fetching leaderboard data`);
        console.log(`   URL: ${apiUrl}`);
        
        const response = await axios.get(apiUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Leaderboard-Backend/1.0'
            }
        });
        
        console.log(`✅ External API responded with ${response.data?.list?.length || 0} players`);
        
        res.json({
            success: true,
            data: response.data,
            competition: {
                isActive: competitionState.isActive,
                isEnded: competitionState.isEnded,
                startTime: competitionState.startTime,
                endTime: competitionState.endTime,
                remainingSeconds: calculateRemainingSeconds(competitionState.endTime)
            },
            fetchedAt: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Error fetching leaderboard:', error.message);
        
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({
                success: false,
                message: 'External API request timed out. Please try again.'
            });
        }
        
        if (error.response) {
            console.error('External API error details:', error.response.data);
            
            return res.status(502).json({
                success: false,
                message: 'External API error. Please try again later.',
                ...(process.env.NODE_ENV === 'development' && {
                    details: error.response.data
                })
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Failed to fetch leaderboard data',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

app.get('/api/status', (req, res) => {
    checkAndUpdateCompetitionStatus();
    
    res.json({
        success: true,
        competition: {
            isActive: competitionState.isActive,
            isEnded: competitionState.isEnded,
            startTime: competitionState.startTime,
            endTime: competitionState.endTime,
            remainingSeconds: calculateRemainingSeconds(competitionState.endTime),
            durationDays: competitionState.durationDays || CONFIG.COMPETITION_DURATION_DAYS
        },
        serverTime: new Date().toISOString()
    });
});

// ===================================================================
// # ADMIN ROUTES (Protected)
// ===================================================================

app.post('/api/admin/start', authenticateAdmin, (req, res) => {
    try {
        checkAndUpdateCompetitionStatus();
        
        if (competitionState.isActive && !competitionState.isEnded) {
            return res.status(400).json({
                success: false,
                message: 'Competition is already active. Reset it first.',
                currentState: {
                    startTime: competitionState.startTime,
                    endTime: competitionState.endTime,
                    remainingSeconds: calculateRemainingSeconds(competitionState.endTime)
                }
            });
        }
        
        const durationDays = req.body.durationDays || CONFIG.COMPETITION_DURATION_DAYS;
        
        if (durationDays < 1 || durationDays > 365) {
            return res.status(400).json({
                success: false,
                message: 'Duration must be between 1 and 365 days'
            });
        }
        
        const now = new Date();
        const endTime = new Date(now.getTime() + (durationDays * 24 * 60 * 60 * 1000));
        
        competitionState = {
            isActive: true,
            startTime: now.toISOString(),
            endTime: endTime.toISOString(),
            isEnded: false,
            createdAt: now.toISOString(),
            durationDays
        };
        
        console.log(`🚀 Competition started: ${durationDays} days`);
        console.log(`   Start: ${competitionState.startTime}`);
        console.log(`   End:   ${competitionState.endTime}`);
        
        res.json({
            success: true,
            message: `Competition started successfully (${durationDays} days)`,
            competition: {
                ...competitionState,
                remainingSeconds: calculateRemainingSeconds(competitionState.endTime)
            }
        });
        
    } catch (error) {
        console.error('❌ Error starting competition:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to start competition',
            error: error.message
        });
    }
});

app.post('/api/admin/reset', authenticateAdmin, (req, res) => {
    try {
        const previousState = { ...competitionState };
        
        competitionState = {
            isActive: false,
            startTime: null,
            endTime: null,
            isEnded: false,
            createdAt: null
        };
        
        console.log('🔄 Competition reset - all state cleared');
        
        res.json({
            success: true,
            message: 'Competition reset successfully',
            previousState,
            newState: competitionState
        });
        
    } catch (error) {
        console.error('❌ Error resetting competition:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset competition',
            error: error.message
        });
    }
});

app.get('/api/admin/status', authenticateAdmin, (req, res) => {
    checkAndUpdateCompetitionStatus();
    
    const remaining = calculateRemainingSeconds(competitionState.endTime);
    
    res.json({
        success: true,
        competition: {
            isActive: competitionState.isActive,
            isEnded: competitionState.isEnded,
            startTime: competitionState.startTime,
            endTime: competitionState.endTime,
            createdAt: competitionState.createdAt,
            remainingSeconds: remaining,
            remainingDays: Math.ceil(remaining / 86400),
            durationDays: competitionState.durationDays || CONFIG.COMPETITION_DURATION_DAYS
        },
        serverTime: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ===================================================================
// # HEALTH CHECK
// ===================================================================

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '1.0.3-vercel'
    });
});

// ===================================================================
// # ERROR HANDLING
// ===================================================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        path: req.path
    });
});

app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    
    res.status(err.status || 500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ===================================================================
// # START SERVER
// ===================================================================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║            🚀 LEADERBOARD BACKEND API RUNNING              ║
║                  (VERCEL DEPLOYMENT)                       ║
╚════════════════════════════════════════════════════════════╝

🌐 Server:     http://localhost:${PORT}
🔑 Admin Key:  ${CONFIG.ADMIN_API_KEY === 'change-me-in-production' ? '⚠️  USING DEFAULT KEY!' : '✅ Custom key set'}
📊 API:        ${CONFIG.EXTERNAL_API_BASE}
📝 Max Records: ${CONFIG.MAX_RECORDS_PER_REQUEST} per request
🌍 Environment: ${process.env.VERCEL ? 'Vercel' : 'Local'}

📝 PUBLIC ENDPOINTS:
   GET  /api/leaderboard          - Fetch leaderboard data
   GET  /api/status               - Competition status
   GET  /api/health               - Health check

🔒 ADMIN ENDPOINTS (require X-API-Key header):
   POST /api/admin/start          - Start competition
   POST /api/admin/reset          - Reset competition
   GET  /api/admin/status         - Detailed status

⚡ Competition Settings:
   Duration: ${CONFIG.COMPETITION_DURATION_DAYS} days
   State: ${competitionState.isActive ? '🟢 ACTIVE' : competitionState.isEnded ? '🔴 ENDED' : '⚪ INACTIVE'}

✨ CORS: Enabled for all origins on Vercel
    `);
    
    if (CONFIG.ADMIN_API_KEY === 'change-me-in-production') {
        console.log(`
⚠️⚠️⚠️  SECURITY WARNING  ⚠️⚠️⚠️
You are using the default admin API key!
Please set ADMIN_API_KEY in your .env file.

Generate a secure key:
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
        `);
    }
});

// ===================================================================
// # AUTOMATIC COMPETITION STATUS CHECKER
// ===================================================================

setInterval(() => {
    if (competitionState.isActive) {
        checkAndUpdateCompetitionStatus();
    }
}, 60000);

console.log('⏰ Competition status checker started (runs every 60 seconds)');

// ===================================================================
// # GRACEFUL SHUTDOWN
// ===================================================================

process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\nSIGINT received. Shutting down gracefully...');
    process.exit(0);
});