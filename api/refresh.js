export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { refresh_token } = req.body;

    if (!refresh_token) {
        return res.status(400).json({ error: 'Refresh token required' });
    }

    try {
        // Exchange refresh token for new access token
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                refresh_token,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                grant_type: 'refresh_token',
            }),
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            console.error('Token refresh error:', errorData);

            // Invalid refresh token - user needs to re-authenticate
            if (errorData.error === 'invalid_grant') {
                return res.status(401).json({ error: 'invalid_refresh_token', message: 'Please sign in again' });
            }

            return res.status(500).json({ error: 'token_refresh_failed', details: errorData });
        }

        const tokens = await tokenResponse.json();

        // tokens contains: access_token, expires_in, scope, token_type
        // Note: refresh_token is NOT returned (you keep using the existing one)

        res.status(200).json({
            access_token: tokens.access_token,
            expires_in: tokens.expires_in,
        });

    } catch (err) {
        console.error('Refresh token error:', err);
        return res.status(500).json({ error: 'server_error', message: err.message });
    }
}
