const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3005;

// Middleware
app.use(cors());
app.use(express.json());

// Performance: Add compression and caching
app.use((req, res, next) => {
    // Cache static assets for 1 hour
    if (req.url.includes('.png') || req.url.includes('.jpg') || req.url.includes('.css') || req.url.includes('.js')) {
        res.setHeader('Cache-Control', 'public, max-age=3600');
    }
    next();
});

app.use(express.static('.', {
    maxAge: '1h',
    etag: true,
    lastModified: true
}));

// ShipStation API credentials
const SHIPSTATION_CONFIG = {
    apiKey: process.env.SHIPSTATION_API_KEY || 'a183673133044e5684005f64f667a8f2',
    apiSecret: process.env.SHIPSTATION_API_SECRET || '912de99690754208a3211be081248166',
    baseUrl: 'https://ssapi.shipstation.com'
};

// Fishbowl API credentials
const FISHBOWL_CONFIG = {
    username: process.env.FISHBOWL_USERNAME || 'admin',
    password: process.env.FISHBOWL_PASSWORD || 'Roy@l1234',
    database: process.env.FISHBOWL_DATABASE || 'Royal_Enterprise_Sandbox',
    baseUrl: process.env.FISHBOWL_BASE_URL || 'http://localhost:2457/api'
};

// MySQL Database Configuration (Alternative direct connection)
const MYSQL_CONFIG = {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '', // Add if needed
    database: 'Royal_Enterprise_Sandbox'
};

// Performance: Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(key) {
    return `cache_${key}`;
}

function setCache(key, data) {
    cache.set(getCacheKey(key), {
        data,
        timestamp: Date.now()
    });
}

function getCache(key) {
    const cached = cache.get(getCacheKey(key));
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    cache.delete(getCacheKey(key));
    return null;
}

// Fishbowl session management
let fishbowlSession = {
    token: null,
    expiresAt: null
};

// Create axios instance with auth for ShipStation
const shipstationClient = axios.create({
    baseURL: SHIPSTATION_CONFIG.baseUrl,
    auth: {
        username: SHIPSTATION_CONFIG.apiKey,
        password: SHIPSTATION_CONFIG.apiSecret
    },
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

// Fishbowl login function
async function fishbowlLogin() {
    try {
        console.log('🔐 Authenticating with Fishbowl...');
        console.log(`📍 Fishbowl URL: ${FISHBOWL_CONFIG.baseUrl}`);
        console.log(`👤 Username: ${FISHBOWL_CONFIG.username}`);
        console.log(`💾 Database: ${FISHBOWL_CONFIG.database}`);
        
        // Try different Fishbowl API endpoints
        const endpoints = [
            '/api/v1/login',
            '/ws/login',
            '/xml/login',
            '/login',
            '/api/login', 
            '/v1/login',
            '/auth/login',
            '/fishbowl/api/login'
        ];
        
        let response = null;
        let lastError = null;
        
        for (const endpoint of endpoints) {
            try {
                console.log(`🔍 Trying endpoint: ${FISHBOWL_CONFIG.baseUrl}${endpoint}`);
                response = await axios.post(`${FISHBOWL_CONFIG.baseUrl}${endpoint}`, {
                    username: FISHBOWL_CONFIG.username,
                    password: FISHBOWL_CONFIG.password,
                    database: FISHBOWL_CONFIG.database
                }, {
                    timeout: 10000,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                console.log(`✅ Success with endpoint: ${endpoint}`);
                break;
            } catch (error) {
                console.log(`❌ Failed endpoint ${endpoint}: ${error.response?.status || error.message}`);
                lastError = error;
            }
        }
        
        if (!response) {
            throw lastError || new Error('All Fishbowl login endpoints failed');
        }

        fishbowlSession.token = response.data.token;
        // Set expiration to 30 minutes from now (adjust based on Fishbowl's actual timeout)
        fishbowlSession.expiresAt = Date.now() + (30 * 60 * 1000);
        
        console.log('✅ Fishbowl session established');
        return fishbowlSession.token;
    } catch (error) {
        console.error('❌ Fishbowl login failed:', error.response?.data || error.message);
        throw error;
    }
}

// Get valid Fishbowl session (login if needed or expired)
async function getFishbowlToken() {
    if (!fishbowlSession.token || Date.now() >= fishbowlSession.expiresAt) {
        return await fishbowlLogin();
    }
    return fishbowlSession.token;
}

// Fishbowl API call with auto-retry on session expiration
async function callFishbowlAPI(method, endpoint, data = null) {
    try {
        const token = await getFishbowlToken();
        const url = `${FISHBOWL_CONFIG.baseUrl}${endpoint}`;
        
        const config = {
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        };

        let response;
        if (method === 'GET') {
            response = await axios.get(url, config);
        } else if (method === 'POST') {
            response = await axios.post(url, data, config);
        } else if (method === 'PUT') {
            response = await axios.put(url, data, config);
        }
        
        return response.data;
    } catch (error) {
        // Check if it's a session/auth error
        if (error.response?.status === 401 || error.response?.status === 403) {
            console.log('⚠️ Session expired or invalid, re-authenticating...');
            fishbowlSession.token = null;
            fishbowlSession.expiresAt = null;
            
            // Retry once
            const token = await getFishbowlToken();
            const url = `${FISHBOWL_CONFIG.baseUrl}${endpoint}`;
            
            const config = {
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            };

            let response;
            if (method === 'GET') {
                response = await axios.get(url, config);
            } else if (method === 'POST') {
                response = await axios.post(url, data, config);
            }
            
            return response.data;
        }
        
        throw error;
    }
}

// Proxy endpoint for ShipStation orders
app.get('/api/orders', async (req, res) => {
    try {
        // Log environment variable status (for debugging)
        console.log(`🔑 ShipStation API Key: ${SHIPSTATION_CONFIG.apiKey ? 'SET' : 'NOT SET'}`);
        console.log(`🔑 ShipStation API Secret: ${SHIPSTATION_CONFIG.apiSecret ? 'SET' : 'NOT SET'}`);
        
        if (!SHIPSTATION_CONFIG.apiKey || !SHIPSTATION_CONFIG.apiSecret) {
            return res.status(500).json({
                error: 'ShipStation API credentials not configured',
                debug: {
                    apiKey: !!SHIPSTATION_CONFIG.apiKey,
                    apiSecret: !!SHIPSTATION_CONFIG.apiSecret,
                    usingEnvVars: !!process.env.SHIPSTATION_API_KEY
                }
            });
        }

        const pageSize = req.query.pageSize || 100;
        const page = req.query.page || 1;
        const sortField = req.query.sortField || 'orderDate';
        const sortDirection = req.query.sortDirection || 'DESC';
        const orderDateStart = req.query.orderDateStart || '2000-01-01';

        // Check cache first
        const cacheKey = `orders_${pageSize}_${page}_${sortField}_${sortDirection}_${orderDateStart}`;
        const cachedData = getCache(cacheKey);
        
        if (cachedData) {
            console.log(`📦 Serving ${cachedData.orders?.length || 0} orders from cache`);
            return res.json(cachedData);
        }

        console.log(`📡 Fetching orders - Page: ${page}, PageSize: ${pageSize}, Start: ${orderDateStart}`);
        console.log(`🔑 Using API Key: ${SHIPSTATION_CONFIG.apiKey ? SHIPSTATION_CONFIG.apiKey.substring(0, 8) + '...' : 'NOT SET'}`);
        console.log(`🌐 ShipStation Base URL: ${SHIPSTATION_CONFIG.baseUrl}`);

        let response;
        
        try {
            const params = {
                pageSize,
                page,
                sortField,
                sortDirection,
                orderDateStart,
                includeShipmentDetails: true,
                orderStatus: 'shipped,awaiting_shipment'
            };
            
            console.log(`📋 Request params:`, JSON.stringify(params, null, 2));
            
            response = await shipstationClient.get('/orders', { params });
            console.log(`✅ ShipStation Response Status: ${response.status}`);
            console.log(`✅ Orders received: ${response.data.orders?.length || 0}`);
            
        } catch (apiError) {
            console.error('❌ ShipStation API Error:', apiError.message);
            console.error('❌ Full Error:', JSON.stringify(apiError, null, 2));
            
            if (apiError.response) {
                console.error('❌ API Response:', {
                    status: apiError.response.status,
                    statusText: apiError.response.statusText,
                    data: apiError.response.data
                });
            }
            
            if (apiError.code === 'ENOTFOUND' || apiError.code === 'ECONNREFUSED') {
                console.error('❌ Network Error - Cannot reach ShipStation');
            }
            
            // Use fallback data for better user experience
            console.log(`🔄 Using fallback data due to ShipStation API failure`);
            const mockOrders = generateMockOrders(pageSize);
            
            return res.json({
                success: true,
                orders: mockOrders,
                total: 1000,
                page: page,
                pages: Math.ceil(1000 / pageSize),
                fallback: true,
                message: 'Using sample data due to ShipStation API issues',
                timestamp: new Date().toISOString()
            });
        }
        
        // Return the real ShipStation data
        const responseData = {
            success: true,
            orders: response.data.orders || [],
            total: response.data.total || 0,
            page: response.data.page || page,
            pages: response.data.pages || 1,
            timestamp: new Date().toISOString()
        };
        
        // Cache the response
        setCache(cacheKey, responseData);
        
        res.json(responseData);
        
    } catch (error) {
        console.error('❌ General API Error:', error.response?.status, error.response?.statusText, error.message);
        
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.message,
            details: error.response?.data || null,
            statusCode: error.response?.status || 500,
            timestamp: new Date().toISOString(),
            debug: {
                apiKey: SHIPSTATION_CONFIG.apiKey ? 'SET' : 'NOT SET',
                apiSecret: SHIPSTATION_CONFIG.apiSecret ? 'SET' : 'NOT SET',
                baseUrl: SHIPSTATION_CONFIG.baseUrl
            }
        });
    }
});

// Generate mock orders for fallback
function generateMockOrders(count = 100) {
    const orders = [];
    const customers = ['Amazon Customer', 'eBay Buyer', 'Shopify Customer', 'Walmart Order', 'Etsy Shopper'];
    const statuses = ['awaiting_shipment', 'shipped', 'on_hold', 'cancelled'];
    
    for (let i = 0; i < count; i++) {
        orders.push({
            orderId: 100000 + i,
            orderNumber: `#${100000 + i}`,
            customerName: customers[Math.floor(Math.random() * customers.length)],
            orderDate: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
            shipTo: {
                name: customers[Math.floor(Math.random() * customers.length)],
                street1: `${123 + i} Main St`,
                city: 'Test City',
                state: 'TS',
                postalCode: `${10000 + i}`,
                country: 'US'
            },
            itemsTotal: Math.floor(Math.random() * 500) + 50,
            shippingAmount: Math.floor(Math.random() * 20) + 5,
            orderTotal: Math.floor(Math.random() * 520) + 55,
            orderStatus: statuses[Math.floor(Math.random() * statuses.length)],
            carrierCode: 'stamps_com',
            serviceCode: 'usps_priority'
        });
    }
    
    return orders;
}

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

// Simple test endpoint
app.get('/api/test', (req, res) => {
    res.json({ 
        message: 'API test working!',
        server: 'Node.js',
        environment: process.env.NODE_ENV || 'development',
        vercel: !!process.env.VERCEL,
        origin: req.get('origin') || req.get('host'),
        timestamp: new Date().toISOString()
    });
});

// Debug ShipStation config
app.get('/api/debug', (req, res) => {
    res.json({ 
        shipstationConfig: {
            apiKey: SHIPSTATION_CONFIG.apiKey ? 'SET' : 'NOT SET',
            apiSecret: SHIPSTATION_CONFIG.apiSecret ? 'SET' : 'NOT SET',
            baseUrl: SHIPSTATION_CONFIG.baseUrl,
            apiKeyLength: SHIPSTATION_CONFIG.apiKey ? SHIPSTATION_CONFIG.apiKey.length : 0,
            usingEnvVars: {
                apiKey: !!process.env.SHIPSTATION_API_KEY,
                apiSecret: !!process.env.SHIPSTATION_API_SECRET
            }
        },
        fishbowlConfig: {
            username: FISHBOWL_CONFIG.username,
            database: FISHBOWL_CONFIG.database,
            baseUrl: FISHBOWL_CONFIG.baseUrl
        },
        environment: {
            nodeEnv: process.env.NODE_ENV,
            vercel: !!process.env.VERCEL,
            isProduction: process.env.NODE_ENV === 'production'
        },
        timestamp: new Date().toISOString()
    });
});

// Test ShipStation connection
app.get('/api/shipstation/test', async (req, res) => {
    try {
        console.log('🔍 Testing ShipStation connection...');
        
        // Test basic connection
        const carriersResponse = await shipstationClient.get('/carriers', { timeout: 10000 });
        console.log(`✅ Carriers endpoint working: ${carriersResponse.data?.length || 0} carriers`);
        
        // Test orders endpoint with small limit
        const ordersResponse = await shipstationClient.get('/orders', { 
            params: { pageSize: 5, page: 1 },
            timeout: 10000 
        });
        console.log(`✅ Orders endpoint working: ${ordersResponse.data?.orders?.length || 0} orders`);
        
        res.json({
            success: true,
            message: 'ShipStation API connection successful',
            carriers: carriersResponse.data?.length || 0,
            orders: ordersResponse.data?.orders?.length || 0,
            totalOrders: ordersResponse.data?.total || 0,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ ShipStation test failed:', error.response?.status, error.message);
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.message,
            status: error.response?.status,
            statusText: error.response?.statusText,
            details: error.response?.data || null,
            timestamp: new Date().toISOString()
        });
    }
});

// Test Fishbowl connection
app.get('/api/fishbowl/test', async (req, res) => {
    try {
        console.log('🔍 Testing Fishbowl connection...');
        
        // Test if Fishbowl server is reachable
        const testEndpoints = [
            '/',
            '/api',
            '/api/v1',
            '/api/v1/login',
            '/login',
            '/v1',
            '/v1/login',
            '/ws',
            '/ws/login',
            '/xml',
            '/xml/login',
            '/fishbowl',
            '/fishbowl/api'
        ];
        
        const results = [];
        
        for (const endpoint of testEndpoints) {
            try {
                const response = await axios.get(`${FISHBOWL_CONFIG.baseUrl}${endpoint}`, {
                    timeout: 5000,
                    validateStatus: () => true // Accept any status code
                });
                results.push({
                    endpoint: endpoint,
                    status: response.status,
                    statusText: response.statusText,
                    success: response.status < 500
                });
            } catch (error) {
                results.push({
                    endpoint: endpoint,
                    status: 'ERROR',
                    statusText: error.message,
                    success: false
                });
            }
        }
        
        res.json({
            fishbowlUrl: FISHBOWL_CONFIG.baseUrl,
            username: FISHBOWL_CONFIG.username,
            database: FISHBOWL_CONFIG.database,
            testResults: results,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Fishbowl endpoints
app.get('/api/fishbowl/orders', async (req, res) => {
    try {
        console.log('📡 Fetching orders from Fishbowl...');
        const data = await callFishbowlAPI('GET', '/orders');
        console.log(`✅ Received ${data.orders?.length || 0} orders from Fishbowl`);
        res.json(data);
    } catch (error) {
        console.error('❌ Fishbowl API Error:', error.response?.status, error.message);
        const statusCode = error.response?.status || 500;
        res.status(statusCode).json({
            error: error.message,
            details: error.response?.data || null,
            timestamp: new Date().toISOString()
        });
    }
});

app.get('/api/fishbowl/inventory', async (req, res) => {
    try {
        console.log('📡 Fetching inventory from Fishbowl...');
        const data = await callFishbowlAPI('GET', '/inventory');
        res.json(data);
    } catch (error) {
        console.error('❌ Fishbowl API Error:', error.message);
        res.status(error.response?.status || 500).json({
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/fishbowl/logout', async (req, res) => {
    try {
        if (fishbowlSession.token) {
            await axios.post(`${FISHBOWL_CONFIG.baseUrl}/logout`, {}, {
                headers: {
                    'Authorization': `Bearer ${fishbowlSession.token}`
                }
            });
        }
        fishbowlSession.token = null;
        fishbowlSession.expiresAt = null;
        console.log('✅ Fishbowl session closed');
        res.json({ status: 'logged out' });
    } catch (error) {
        console.error('⚠️ Logout error (non-critical):', error.message);
        fishbowlSession.token = null;
        res.json({ status: 'logged out' });
    }
});

// Serve frontend pages - use absolute paths for Vercel compatibility
app.get('/', (req, res) => {
    res.sendFile('./login.html', { root: '.' });
});

app.get('/login.html', (req, res) => {
    res.sendFile('./login.html', { root: '.' });
});

// Serve static assets
app.get('/logo_rw.png', (req, res) => {
    res.sendFile('./logo_rw.png', { root: '.' });
});

app.get('/favicon.png', (req, res) => {
    res.sendFile('./favicon.png', { root: '.' });
});

app.get('/orders-new.html', (req, res) => {
    res.sendFile('./orders-new.html', { root: '.' });
});

app.get('/warehouse-new.html', (req, res) => {
    res.sendFile('./warehouse-new.html', { root: '.' });
});

app.get('/tracking-new.html', (req, res) => {
    res.sendFile('./tracking-new.html', { root: '.' });
});

app.get('/log-new.html', (req, res) => {
    res.sendFile('./log-new.html', { root: '.' });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📡 ShipStation API proxy available at http://localhost:${PORT}/api/orders`);
    console.log(`🐟 Fishbowl API proxy available at http://localhost:${PORT}/api/fishbowl/*`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('⏸️  SIGTERM received, shutting down gracefully...');
    try {
        await axios.post(`${FISHBOWL_CONFIG.baseUrl}/logout`, {}, {
            headers: {
                'Authorization': `Bearer ${fishbowlSession.token}`
            }
        }).catch(() => {});
    } catch (e) {}
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('⏸️  SIGINT received, shutting down gracefully...');
    try {
        await axios.post(`${FISHBOWL_CONFIG.baseUrl}/logout`, {}, {
            headers: {
                'Authorization': `Bearer ${fishbowlSession.token}`
            }
        }).catch(() => {});
    } catch (e) {}
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
