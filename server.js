require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // Use service key for backend
);

app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json());

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { plan, userId, email, skipTrial } = req.body;

    const prices = {
      weekly: process.env.STRIPE_WEEKLY_PRICE_ID,
      lifetime: process.env.STRIPE_LIFETIME_PRICE_ID
    };

    const sessionConfig = {
      customer_email: email,
      client_reference_id: userId,
      line_items: [{ price: prices[plan], quantity: 1 }],
      mode: plan === 'lifetime' ? 'payment' : 'subscription',
      success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/pricing`,
      metadata: { userId, plan }
    };

    // Add trial if weekly and not skipped
    if (plan === 'weekly' && !skipTrial) {
      sessionConfig.subscription_data = { trial_period_days: 7 };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Webhook handler
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutComplete(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Webhook handler failed');
  }
});

// Webhook handlers
async function handleCheckoutComplete(session) {
  const userId = session.metadata.userId;
  const plan = session.metadata.plan;
  
  const updateData = {
    subscription_tier: plan,
    subscription_status: session.mode === 'subscription' 
      ? (session.subscription ? 'trial' : 'active')
      : 'active',
    stripe_customer_id: session.customer,
    subscription_start_date: new Date().toISOString()
  };

  if (session.subscription) {
    updateData.stripe_subscription_id = session.subscription;
    // Calculate trial end date
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 7);
    updateData.trial_end_date = trialEnd.toISOString();
  }

  await supabase
    .from('profiles')
    .update(updateData)
    .eq('id', userId);

  // Log payment
  await supabase
    .from('payment_history')
    .insert({
      user_id: userId,
      stripe_payment_id: session.payment_intent || session.id,
      amount: session.amount_total / 100,
      currency: session.currency.toUpperCase(),
      payment_type: plan === 'lifetime' ? 'one_time' : 'subscription',
      status: 'succeeded'
    });
}

async function handleSubscriptionUpdate(subscription) {
  const status = subscription.status === 'trialing' ? 'trial' : 
                 subscription.status === 'active' ? 'active' : 
                 'past_due';

  await supabase
    .from('profiles')
    .update({ 
      subscription_status: status,
      last_payment_date: new Date().toISOString()
    })
    .eq('stripe_subscription_id', subscription.id);
}

async function handleSubscriptionDeleted(subscription) {
  await supabase
    .from('profiles')
    .update({
      subscription_status: 'canceled',
      subscription_tier: 'free',
      subscription_end_date: new Date().toISOString()
    })
    .eq('stripe_subscription_id', subscription.id);
}

async function handlePaymentSucceeded(invoice) {
  if (!invoice.subscription) return;

  await supabase
    .from('profiles')
    .update({ 
      subscription_status: 'active',
      last_payment_date: new Date().toISOString()
    })
    .eq('stripe_subscription_id', invoice.subscription);
}

async function handlePaymentFailed(invoice) {
  await supabase
    .from('profiles')
    .update({ subscription_status: 'past_due' })
    .eq('stripe_subscription_id', invoice.subscription);
}

// Create customer portal session (for cancellations)
app.post('/create-portal-session', async (req, res) => {
  try {
    const { customerId } = req.body;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.CLIENT_URL}/account`
    });
    res.json({ url: session.url });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));