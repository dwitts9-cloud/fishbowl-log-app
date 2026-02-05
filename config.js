// Dynamic API configuration
window.API_CONFIG = {
    // Check if we're in development or production
    isDevelopment: window.location.hostname === 'localhost' || 
                   window.location.hostname === '127.0.0.1' ||
                   window.location.hostname.includes('ngrok') ||
                   window.location.port !== '',
    
    // Local server URL (for development)
    localApiUrl: 'http://localhost:3005/api',
    
    // Vercel API URL (for production)
    vercelApiUrl: window.location.origin + '/api',
    
    // Get the appropriate API URL
    getApiUrl: function() {
        // For local development, try to connect to local server
        if (this.isDevelopment) {
            return this.localApiUrl;
        }
        // For production, use Vercel API
        return this.vercelApiUrl;
    },
    
    // Test connection to local server
    testLocalConnection: async function() {
        try {
            const response = await fetch(this.localApiUrl + '/test', {
                method: 'GET',
                timeout: 5000
            });
            return response.ok;
        } catch (error) {
            console.log('Local server not available:', error.message);
            return false;
        }
    },
    
    // Get API URL with fallback
    getApiUrlWithFallback: async function() {
        // First try to connect to local server
        if (this.isDevelopment && await this.testLocalConnection()) {
            console.log('🔌 Using local server:', this.localApiUrl);
            return this.localApiUrl;
        }
        
        // Fallback to Vercel API
        console.log('🌐 Using Vercel API:', this.vercelApiUrl);
        return this.vercelApiUrl;
    }
};
