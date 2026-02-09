export default async function handler(req, res) {
    // Only allow GET requests
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { code, error } = req.query;

    // Handle OAuth errors
    if (error) {
        console.error('OAuth error:', error);
        return res.redirect(`${process.env.FRONTEND_URL}?error=${encodeURIComponent(error)}`);
    }

    // No code provided
    if (!code) {
        return res.status(400).json({ error: 'Authorization code missing' });
    }

    try {
        // Exchange authorization code for tokens
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: `${process.env.FRONTEND_URL}/api/auth`,
                grant_type: 'authorization_code',
            }),
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            console.error('Token exchange error:', errorData);
            return res.redirect(`${process.env.FRONTEND_URL}?error=token_exchange_failed`);
        }

        const tokens = await tokenResponse.json();

        // tokens contains: access_token, refresh_token, expires_in, scope, token_type

        // Redirect back to frontend with tokens as URL fragments (client-side only)
        // Using fragment (#) instead of query (?) to prevent tokens from being logged in server logs
        const redirectUrl = `${process.env.FRONTEND_URL}#access_token=${tokens.access_token}&refresh_token=${tokens.refresh_token}&expires_in=${tokens.expires_in}`;

        res.redirect(redirectUrl);

    } catch (err) {
        console.error('Auth callback error:', err);
        return res.redirect(`${process.env.FRONTEND_URL}?error=server_error`);
    }
}
