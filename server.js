const express = require('express');
const Stripe = require('stripe');
const app = express();
const port = 3000;

// Allow parsing JSON from the frontend
app.use(express.json());

// Middleware to set headers for real-time updates
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  next();
});

// The main endpoint that checks keys
app.post('/check-keys', async (req, res) => {
  const { keys } = req.body;
  if (!Array.isArray(keys)) {
    res.write(JSON.stringify({ error: "Keys must be an array" }) + '\n');
    return;
  }

  // Use a Set to store valid keys to ensure uniqueness if the input has duplicates
  const validKeys = new Set();
  const invalidKeys = new Set();

  // Process keys in batches to prevent overwhelming Stripe's rate limits
  // Stripe allows about 40 requests/second per key type
  const batchSize = 100;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    
    // Run the batch in parallel
    const promises = batch.map(async (key) => {
      try {
        const stripe = new Stripe(key, { apiVersion: '2022-11-15' });
        await stripe.customers.list({ limit: 1 }); // Simple validation call
        return { key, status: 'valid' };
      } catch (error) {
        // Check if the error is specifically an authentication error (401)
        // Stripe returns an error object, we check its code/type
        if (error.type === 'StripeError' || (error.statusCode && error.statusCode === 401)) {
          return { key, status: 'invalid' };
        }
        // Log other errors (like network issues) but don't mark key as invalid
        console.error(`Error checking ${key}:`, error.message);
        return { key, status: 'error', error: error.message };
      }
    });

    const results = await Promise.all(promises);

    // Send results back to the frontend
    res.write(JSON.stringify(results) + '\n');

    // If we found the first valid key, we can stop early
    const validResult = results.find(r => r.status === 'valid');
    if (validResult) {
      res.write(JSON.stringify({ 
        message: `Found first valid key: ${validResult.key}! Stopping.`, 
        found: true,
        key: validResult.key
      }) + '\n');
      
      res.write('done'); // Signal end of stream
      res.end();
      return;
    }
  }

  // If no valid key was found in the loop
  res.write(JSON.stringify({ message: "No valid keys found." }) + '\n');
  res.write('done');
  res.end();
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
