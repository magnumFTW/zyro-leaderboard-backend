/* ===================================================================
 * LEADERBOARD BACKEND API - Express.js (COMPLETE FIXED VERSION)
 * 
 * Features:
 * - Public leaderboard endpoint (proxies external API)
 * - Admin-protected endpoints for timer control
 * - 30-day competition timer management
 * - CORS enabled for local and hosted frontends
 * - Fixed date range logic (never queries future data)
 * - Auto-check for competition end
 * 
 * Setup:
 * 1. npm install express axios dotenv cors
 * 2. Create .env file with ADMIN_API_KEY=your_secret_key
 * 3. node src/index.js
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
    MAX_RECORDS_PER_REQUEST: 30  // API limit
};

// ===================================================================
// # IN-MEMORY STATE STORAGE
// ===================================================================
// In production, replace this with Redis or a database
let competitionState = {
    isActive: false,
    startTime: null,      // ISO 8601 timestamp
    endTime: null,        // ISO 8601 timestamp
    isEnded: false,
    createdAt: null
};

// ===================================================================
// # MIDDLEWARE
// ===================================================================

// Enable CORS for local development and production
app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (mobile apps, curl, Postman, file://)
        if (!origin) return callback(null, true);
        
        const allowedOrigins = [
            'http://127.0.0.1:5500',
            'http://localhost:5500',
            'http://127.0.0.1:8080',
            'http://localhost:8080',
            'http://localhost:3000',
            process.env.FRONTEND_URL
        ].filter(Boolean);
        
        // Check if origin is in allowed list
        if (allowedOrigins.indexOf(origin) !== -1) {
            return callback(null, true);
        }
        
        // In development mode, allow all origins for easier testing
        if (process.env.NODE_ENV === 'development') {
            return callback(null, true);
        }
        
        // In production, block unknown origins
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

// Parse JSON request bodies
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// ===================================================================
// # AUTHENTICATION MIDDLEWARE
// ===================================================================

/**
 * Validates admin API key from request headers
 * Expects: X-API-Key header with valid admin key
 */
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
    
    // API key is valid, proceed
    next();
}

// ===================================================================
// # UTILITY FUNCTIONS
// ===================================================================

/**
 * Calculate remaining time in seconds
 * @param {string} endTimeISO - ISO 8601 end timestamp
 * @returns {number} Remaining seconds (0 if expired)
 */
function calculateRemainingSeconds(endTimeISO) {
    if (!endTimeISO) return 0;
    
    const now = new Date().getTime();
    const end = new Date(endTimeISO).getTime();
    const diffMs = end - now;
    
    return Math.max(0, Math.floor(diffMs / 1000));
}

/**
 * Check if competition should be marked as ended
 * Updates state if competition time has expired
 */
function checkAndUpdateCompetitionStatus() {
    if (!competitionState.isActive) return;
    
    const remaining = calculateRemainingSeconds(competitionState.endTime);
    
    if (remaining === 0 && !competitionState.isEnded) {
        competitionState.isEnded = true;
        competitionState.isActive = false;
        console.log('🏁 Competition has ended automatically');
    }
}

/**
 * Get date range for API queries
 * For active competitions: from competition start to RIGHT NOW (or end if passed)
 * For inactive: rolling 30-day window
 * @returns {object} { from: ISO_DATE, to: ISO_DATE }
 */
function getCompetitionDateRange() {
    // If competition is active, use its date range
    if (competitionState.isActive && competitionState.startTime && competitionState.endTime) {
        const now = new Date();
        const competitionEnd = new Date(competitionState.endTime);
        
        // CRITICAL: Use the earlier of "right now" OR "competition end"
        // This ensures we never query for future data
        const effectiveTo = now < competitionEnd ? now : competitionEnd;
        
        console.log('📅 Active competition:');
        console.log(`   From: ${competitionState.startTime} (start)`);
        console.log(`   To: ${effectiveTo.toISOString()} (${now < competitionEnd ? 'now' : 'end'})`);
        
        return {
            from: competitionState.startTime,       // Fixed: competition start
            to: effectiveTo.toISOString()          // Dynamic: now (or end if over)
        };
    }
    
    // No active competition: show last 30 days by default
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
    
    console.log('📅 No active competition - showing last 30 days');
    console.log(`   From: ${thirtyDaysAgo.toISOString()}`);
    console.log(`   To: ${now.toISOString()}`);
    
    return {
        from: thirtyDaysAgo.toISOString(),  // 30 days ago
        to: now.toISOString()               // Right now
    };
}

// ===================================================================
// # PUBLIC ROUTES
// ===================================================================

/**
 * GET /api/leaderboard
 * Public endpoint - proxies external API with dynamic date filtering
 */
app.get('/api/leaderboard', async (req, res) => {
    try {
        // Update competition status before fetching
        checkAndUpdateCompetitionStatus();
        
        // Get current competition date range
        const { from, to } = getCompetitionDateRange();
        
        // Build external API URL
        const apiUrl = `${CONFIG.EXTERNAL_API_BASE}` +
            `?token=${CONFIG.EXTERNAL_API_TOKEN}` +
            `&skip=0` +
            `&take=${CONFIG.MAX_RECORDS_PER_REQUEST}` +
            `&order=DESC` +
            `&from=${from}` +
            `&to=${to}`;
        
        console.log(`📊 Fetching leaderboard data`);
        console.log(`   URL: ${apiUrl}`);
        
        // Fetch data from external API
        const response = await axios.get(apiUrl, {
            timeout: 10000, // 10 second timeout
            headers: {
                'User-Agent': 'Leaderboard-Backend/1.0'
            }
        });
        
        console.log(`✅ External API responded with ${response.data?.list?.length || 0} players`);
        
        // Return proxied data with additional metadata
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
        
        // Handle different error types
        if (error.code === 'ECONNABORTED') {
            return res.status(504).json({
                success: false,
                message: 'External API request timed out. Please try again.'
            });
        }
        
        if (error.response) {
            // External API returned an error
            console.error('External API error details:', error.response.data);
            
            return res.status(502).json({
                success: false,
                message: 'External API error. Please try again later.',
                // Only show details in development
                ...(process.env.NODE_ENV === 'development' && {
                    details: error.response.data
                })
            });
        }
        
        // Generic error
        res.status(500).json({
            success: false,
            message: 'Failed to fetch leaderboard data',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * GET /api/status
 * Public endpoint - returns competition status without admin auth
 */
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
            durationDays: CONFIG.COMPETITION_DURATION_DAYS
        },
        serverTime: new Date().toISOString()
    });
});

// ===================================================================
// # ADMIN ROUTES (Protected)
// ===================================================================

/**
 * POST /api/admin/start
 * Starts a new 30-day competition
 * Requires: X-API-Key header
 * Body (optional): { durationDays: number }
 */
app.post('/api/admin/start', authenticateAdmin, (req, res) => {
    try {
        checkAndUpdateCompetitionStatus();
        
        // Prevent starting if already active
        if (competitionState.isActive && !competitionState.isEnded) {
            return res.status(400).json({
                success: false,
                message: 'Competition is already active',
                currentState: {
                    startTime: competitionState.startTime,
                    endTime: competitionState.endTime,
                    remainingSeconds: calculateRemainingSeconds(competitionState.endTime)
                }
            });
        }
        
        // Get duration from request or use default
        const durationDays = req.body.durationDays || CONFIG.COMPETITION_DURATION_DAYS;
        
        // Validate duration
        if (durationDays < 1 || durationDays > 365) {
            return res.status(400).json({
                success: false,
                message: 'Duration must be between 1 and 365 days'
            });
        }
        
        // Calculate timestamps
        const now = new Date();
        const endTime = new Date(now.getTime() + (durationDays * 24 * 60 * 60 * 1000));
        
        // Update state
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

/**
 * POST /api/admin/reset
 * Resets the competition timer
 * Requires: X-API-Key header
 */
app.post('/api/admin/reset', authenticateAdmin, (req, res) => {
    try {
        const previousState = { ...competitionState };
        
        // Reset state
        competitionState = {
            isActive: false,
            startTime: null,
            endTime: null,
            isEnded: false,
            createdAt: null
        };
        
        console.log('🔄 Competition reset');
        
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

/**
 * GET /api/admin/status
 * Returns detailed competition status (admin view)
 * Requires: X-API-Key header
 */
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

/**
 * GET /api/health
 * Health check endpoint for monitoring
 */
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: '1.0.0'
    });
});

// ===================================================================
// # ERROR HANDLING
// ===================================================================

// 404 handler for unknown routes
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        path: req.path
    });
});

// Global error handler
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
╚════════════════════════════════════════════════════════════╝

🌐 Server:     http://localhost:${PORT}
🔑 Admin Key:  ${CONFIG.ADMIN_API_KEY === 'change-me-in-production' ? '⚠️  USING DEFAULT KEY!' : '✅ Custom key set'}
📊 API:        ${CONFIG.EXTERNAL_API_BASE}

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
   State: ${competitionState.isActive ? '🟢 ACTIVE' : '⚪ INACTIVE'}

⚠️  Note: Using in-memory storage. State will reset on server restart.
    For production, integrate a database or Redis.
    `);
    
    // Warn if using default API key
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

// Automatically check if competition should end every minute
setInterval(() => {
    if (competitionState.isActive) {
        checkAndUpdateCompetitionStatus();
    }
}, 60000); // Check every 60 seconds

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