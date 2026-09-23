require('dotenv').config();

const PAGE_TOKEN = process.env.APP_SESSION_TOKEN;

if (!PAGE_TOKEN) {
  console.error('❌ Error: APP_SESSION_TOKEN is missing in .env');
  process.exit(1);
}

async function setupMessengerProfile() {
  console.log('⏳ Configuring Messenger Profile (Get Started button, Greeting, and Ice Breakers)...');

  const profilePayload = {
    // 1. Blue "Get Started" button for first-time visitors
    get_started: {
      payload: 'GET_STARTED'
    },

    // 2. Greeting dialog shown when a customer opens chat before sending any message
    greeting: [
      {
        locale: 'default',
        text: 'Welcome to Luxe Jewelry! ✨ Tap below to explore our handcrafted rings, necklaces, and bracelets.'
      }
    ],

    // 3. Ice Breaker question chips (prompt buttons above the chat bar)
    ice_breakers: [
      {
        locale: 'default',
        call_to_actions: [
          {
            question: '✨ Open Jewelry Store',
            payload: 'OPEN_SHOP'
          },
          {
            question: '💍 How do I place an order?',
            payload: 'HOW_TO_ORDER'
          },
          {
            question: '📍 Where is your store located?',
            payload: 'STORE_LOCATION'
          }
        ]
      }
    ]
  };

  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/me/messenger_profile?access_token=${PAGE_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profilePayload)
    });

    const data = await response.json();

    if (data.result === 'success') {
      console.log('✅ Messenger Profile successfully configured on your Facebook Page!');
      console.log('👉 Features enabled:');
      console.log('   - "Get Started" button');
      console.log('   - Welcome Greeting text');
      console.log('   - 3 Ice Breaker prompt chips ("✨ Open Jewelry Store", etc.)');
    } else {
      console.error('❌ Meta API returned error:', data);
    }
  } catch (err) {
    console.error('❌ Network error contacting Meta Graph API:', err.message);
  }
}

setupMessengerProfile();
