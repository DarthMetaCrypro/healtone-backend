// server.js — HealTone backend on Railway

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Supabase client (service role)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// CORS — allow your frontend domain
app.use(
  cors({
    origin: process.env.CLIENT_URL || 'https://aeonmi.ai',
  })
);

// JSON body parsing for normal routes
app.use(express.json());

// Health check
app.get('/health', (req, res) =>
  res.json({ status: 'OK', time: new Date().toISOString() })
);

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, userId, email } = req.body || {};

    if (!plan || !userId || !email) {
      return res
        .status(400)
        .json({ error: 'Missing plan, userId, or email' });
    }

    const prices = {
      weekly: process.env.STRIPE_WEEKLY_PRICE_ID,
      lifetime: process.env.STRIPE_LIFETIME_PRICE_ID,
    };

    const priceId = prices[plan];
    if (!priceId) {
      return res.status(400).json({ error: 'Unknown plan' });
    }

    const session = await stripe.checkout.sessions.create({
      customer_email: email,
      client_reference_id: userId,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: plan === 'lifetime' ? 'payment' : 'subscription',
      success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/pricing`,
      // 7‑day trial for weekly, if desired
      ...(plan === 'weekly' && {
        subscription_data: { trial_period_days: 7 },
      }),
      metadata: { plan },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Create billing portal session (for Manage Subscription button)
app.post('/create-portal-session', async (req, res) => {
  try {
    const { customerId } = req.body || {};
    if (!customerId) {
      return res.status(400).json({ error: 'Missing customerId' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.CLIENT_URL}/profile.html`,
    });

    res.json({ url: portalSession.url });
  } catch (error) {
    console.error('Portal error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Webhook — raw body for Stripe signature
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log(`Webhook signature failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle only checkout completed for now
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const planFromMeta = session.metadata && session.metadata.plan;
      const inferredPlan = session.subscription ? 'weekly' : 'lifetime';
      const plan = planFromMeta || inferredPlan;

      if (userId && plan) {
        try {
          await supabase
            .from('profiles')
            .update({
              subscription_tier: plan,
              subscription_status: 'active',
              stripe_customer_id: session.customer,
              stripe_subscription_id: session.subscription || null,
            })
            .eq('id', userId);
        } catch (e) {
          console.error('Supabase update error in webhook:', e.message);
        }
      }
    }

    res.json({ received: true });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
