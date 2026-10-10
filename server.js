const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-license-key']
}));
app.use(express.json({ limit: '10mb' }));

// --- Supabase Project 1 (License Keys) ---
const LICENSES_URL = process.env.LICENSES_URL || process.env.SUPABASE_URL;
const LICENSES_KEY = process.env.LICENSES_KEY || process.env.SUPABASE_KEY;

// --- Supabase Project 2 (Customer Registrations) ---
const CUSTOMERS_URL = process.env.CUSTOMERS_URL || process.env.CUSTOMER_SUPABASE_URL;
const CUSTOMERS_KEY = process.env.CUSTOMERS_KEY || process.env.CUSTOMER_SUPABASE_KEY;

const supabaseLicenses = (LICENSES_URL && LICENSES_KEY) ? createClient(LICENSES_URL, LICENSES_KEY, { auth: { persistSession: false } }) : null;
const supabaseCustomers = (CUSTOMERS_URL && CUSTOMERS_KEY) ? createClient(CUSTOMERS_URL, CUSTOMERS_KEY, { auth: { persistSession: false } }) : supabaseLicenses;

// Backward compatibility references
const supabase = supabaseLicenses;
const customerSupabase = supabaseCustomers;

// -----------------------------------------------------------------------------
// 1. Keep-Alive & Health Check Endpoint (Prevents Render idle sleep)
// -----------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    service: 'leadpicker-server',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.status(200).json({
    service: 'Core LeadPicker Remote Backend Engine',
    status: 'Running',
    version: '1.0.0'
  });
});

// -----------------------------------------------------------------------------
// 2. License Authentication Middleware (authenticateLicense)
// -----------------------------------------------------------------------------
async function authenticateLicense(req, res, next) {
  const licenseKey = req.headers['x-license-key'];

  if (!licenseKey || typeof licenseKey !== 'string') {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Missing x-license-key header.'
    });
  }

  const cleanKey = licenseKey.trim().toUpperCase();

  try {
    if (!supabaseLicenses) {
      return res.status(500).json({
        success: false,
        error: 'Server configuration error: LICENSES_URL or LICENSES_KEY environment variables are missing on the server.'
      });
    }

    // A. Query license_keys table in primary Supabase
    const { data: licenseRows, error: licenseError } = await supabaseLicenses
      .from('license_keys')
      .select('*')
      .eq('license_key', cleanKey)
      .limit(1);

    if (licenseError) {
      console.error('[authenticateLicense Supabase Error]:', licenseError);
      return res.status(500).json({
        success: false,
        error: 'Database error validating license key: ' + licenseError.message
      });
    }

    if (!licenseRows || licenseRows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid license key: Key not found in system.'
      });
    }

    const license = licenseRows[0];

    // Check revoked / active status
    if (license.status && String(license.status).toLowerCase() === 'revoked') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: License key has been revoked.'
      });
    }

    if (license.is_active === false || license.active === false) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: License key is inactive.'
      });
    }

    // Check if key is marked as redeemed
    if (license.is_redeemed === false) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: License key has not been activated or redeemed.'
      });
    }

    // B. Query key_registrations to verify activated_at & subscription expiration
    let activatedAt = license.redeemed_at || license.activated_at || license.created_at;
    let expiresAt = license.expires_at || license.expiresAt || null;

    try {
      const targetClient = supabaseCustomers || supabaseLicenses;
      if (targetClient) {
        const { data: regRows } = await targetClient
          .from('key_registrations')
          .select('*')
          .eq('license_key', cleanKey)
          .limit(1);

        if (regRows && regRows.length > 0) {
          const reg = regRows[0];
          activatedAt = reg.activated_at || reg.created_at || activatedAt;
          if (!expiresAt) {
            expiresAt = reg.expires_at || reg.expiration_date;
          }
          req.registration = reg;
        }
      }
    } catch (e) {
      console.warn('[authenticateLicense registration query warning]:', e.message);
    }

    // Compute expiration date if not directly provided
    if (!expiresAt && activatedAt) {
      const actTime = new Date(activatedAt).getTime();
      let durationDays = 30; // fallback 30 days

      if (license.duration_days) {
        durationDays = parseInt(license.duration_days, 10);
      } else if (license.duration_months) {
        durationDays = parseInt(license.duration_months, 10) * 30;
      } else if (license.duration) {
        const match = String(license.duration).match(/(\d+)\s*([a-zA-Z]+)?/);
        if (match) {
          const val = parseInt(match[1], 10);
          const unit = (match[2] || 'days').toLowerCase();
          durationDays = unit.startsWith('month') ? val * 30 : val;
        }
      }
      expiresAt = new Date(actTime + durationDays * 24 * 60 * 60 * 1000).toISOString();
    }

    // Check expiration timestamp
    if (expiresAt) {
      const expTime = new Date(expiresAt).getTime();
      if (!isNaN(expTime) && expTime < Date.now()) {
        return res.status(403).json({
          success: false,
          error: `License expired on ${new Date(expTime).toLocaleDateString()}. Please renew your subscription.`,
          expired: true,
          expiresAt
        });
      }
    }

    // Attach verified user context to request
    req.userTier = (license.tier || license.plan || 'PRO').toUpperCase();
    req.license = license;
    req.expiresAt = expiresAt;

    next();
  } catch (err) {
    console.error('[authenticateLicense Unhandled Error]:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error verifying license.'
    });
  }
}

// -----------------------------------------------------------------------------
// 3. Proprietary Business Logic & Algorithms (Protected Server-Side)
// -----------------------------------------------------------------------------

const INDIAN_LOCATIONS = new Set([
  'delhi', 'new delhi', 'mumbai', 'maharashtra', 'gujarat', 'ahmedabad', 'surat',
  'vadodara', 'rajkot', 'pune', 'nagpur', 'bengaluru', 'bangalore', 'karnataka',
  'tamil nadu', 'chennai', 'coimbatore', 'hyderabad', 'telangana', 'kolkata',
  'west bengal', 'rajasthan', 'jaipur', 'jodhpur', 'punjab', 'ludhiana', 'amritsar',
  'haryana', 'gurgaon', 'gurugram', 'faridabad', 'noida', 'greater noida',
  'uttar pradesh', 'lucknow', 'kanpur', 'prayagraj', 'allahabad', 'varanasi',
  'ghaziabad', 'agra', 'madhya pradesh', 'indore', 'bhopal', 'gwalior', 'kerala',
  'kochi', 'thiruvananthapuram', 'bihar', 'patna', 'odisha', 'bhubaneswar',
  'chandigarh', 'assam', 'guwahati', 'jharkhand', 'ranchi', 'chhattisgarh', 'raipur',
  'uttarakhand', 'dehradun', 'india', 'in'
]);

// Strict check: Only 0-sec leads
function isZeroSecLead(timeText) {
  if (!timeText || typeof timeText !== 'string') return false;
  const clean = timeText.trim().toLowerCase();
  return /(?:^|[^\d])0\s*(?:sec|secs|second|seconds|s)\s*ago\b/i.test(clean) ||
    /\b(?:0\s*s(?:ec)?\s*ago|just\s*now)\b/i.test(clean);
}

// Advanced Country & Regional Normalizer
function checkCountryMatch(cardText, locationText, selectedCountries, flagCountryCode = '') {
  if (!selectedCountries || !Array.isArray(selectedCountries) || selectedCountries.length === 0) {
    return true;
  }

  const combined = `${cardText || ''} ${locationText || ''}`.toLowerCase();
  const flagCode = (flagCountryCode || '').toLowerCase().trim();

  for (const country of selectedCountries) {
    const cLower = String(country || '').toLowerCase().trim();
    if (!cLower) continue;

    // Direct ISO flag match
    if (flagCode && (
      cLower === flagCode ||
      (cLower === 'india' && flagCode === 'in') ||
      (cLower === 'united states' && flagCode === 'us') ||
      (cLower === 'united arab emirates' && flagCode === 'ae') ||
      (cLower === 'united kingdom' && flagCode === 'gb')
    )) {
      return true;
    }

    // Direct text occurrence
    if (combined.includes(cLower)) {
      return true;
    }

    // USA aliases
    if (cLower === 'united states' || cLower === 'us') {
      if (/\b(?:usa?|united\s*states|america)\b/i.test(combined) || flagCode === 'us') return true;
    }

    // UK aliases
    if (cLower === 'united kingdom' || cLower === 'gb' || cLower === 'uk') {
      if (/\b(?:uk|united\s*kingdom|britain|england)\b/i.test(combined) || flagCode === 'gb') return true;
    }

    // UAE aliases
    if (cLower === 'united arab emirates' || cLower === 'ae' || cLower === 'uae') {
      if (/\b(?:uae|dubai|emirates|abu\s*dhabi)\b/i.test(combined) || flagCode === 'ae') return true;
    }

    // India aliases & Domestic Locations mapping
    if (cLower === 'india' || cLower === 'in') {
      if (flagCode === 'in') return true;
      for (const loc of INDIAN_LOCATIONS) {
        if (combined.includes(loc)) return true;
      }
    }
  }

  return false;
}

// Proprietary Scoring & Filter Evaluation Function
function evaluateLeadItem(rawLead, filters = {}) {
  const result = {
    cardId: rawLead.cardId || rawLead.position || 'unknown',
    title: (rawLead.title || 'Untitled Lead').trim(),
    leadTime: rawLead.timeText || '',
    location: (rawLead.locationText || '').trim(),
    matched: false,
    shouldClick: false,
    score: 0,
    rejectionReason: null,
    metrics: {}
  };

  const rawText = (rawLead.rawText || '').toLowerCase();
  const title = (rawLead.title || '').toLowerCase();
  const breadcrumbs = (rawLead.breadcrumbs || '').toLowerCase();
  const locationText = (rawLead.locationText || '').toLowerCase();
  const searchableText = `${title} ${breadcrumbs} ${locationText} ${rawText}`;

  // 1. Strict 0-sec Filter
  const requireZeroSec = filters.requireZeroSec !== false;
  const isZeroSec = isZeroSecLead(rawLead.timeText);
  result.metrics.isZeroSec = isZeroSec;

  if (requireZeroSec && !isZeroSec) {
    result.rejectionReason = 'NON_ZERO_SEC_TIME';
    return result;
  }
  result.score += 30; // base points for fresh 0-sec lead

  // 2. Retail Lead Filter
  const isRetail = Boolean(
    rawLead.isRetail ||
    /retail\s*lead/i.test(rawText) ||
    /retail\s*buyer/i.test(rawText)
  );
  result.metrics.isRetail = isRetail;

  if (filters.enableRetailLeadsFilter !== true && isRetail) {
    result.rejectionReason = 'RETAIL_LEAD_EXCLUDED';
    return result;
  }

  // 3. Country & Regional Filter
  const selectedCountries = Array.isArray(filters.selectedCountries) ? filters.selectedCountries : [];
  if (selectedCountries.length > 0) {
    const isCountryMatched = checkCountryMatch(
      rawText,
      locationText,
      selectedCountries,
      rawLead.flagCountryCode
    );
    if (!isCountryMatched) {
      result.rejectionReason = 'COUNTRY_MISMATCH';
      return result;
    }
    result.score += 20;
  }

  // 4. Positive Cities/States Filter
  const posCities = Array.isArray(filters.positiveCitiesStates) ? filters.positiveCitiesStates : [];
  if (posCities.length > 0) {
    const matchesPosCity = posCities.some(c => {
      const val = String(c || '').toLowerCase().trim();
      return val && (locationText.includes(val) || rawText.includes(val));
    });
    if (!matchesPosCity) {
      result.rejectionReason = 'POSITIVE_CITY_MISMATCH';
      return result;
    }
    result.score += 15;
  }

  // 5. Negative Cities/States Filter
  const negCities = Array.isArray(filters.negativeCitiesStates) ? filters.negativeCitiesStates : [];
  if (negCities.length > 0) {
    const matchesNegCity = negCities.some(c => {
      const val = String(c || '').toLowerCase().trim();
      return val && (locationText.includes(val) || rawText.includes(val));
    });
    if (matchesNegCity) {
      result.rejectionReason = 'NEGATIVE_CITY_EXCLUDED';
      return result;
    }
  }

  // 6. Negative Keywords Rejection
  const negKeywords = Array.isArray(filters.negativeKeywords) ? filters.negativeKeywords : [];
  if (negKeywords.length > 0) {
    for (const kw of negKeywords) {
      const kwText = String(kw?.text || kw || '').toLowerCase().trim();
      if (kwText && searchableText.includes(kwText)) {
        result.rejectionReason = `NEGATIVE_KEYWORD_MATCH: ${kwText}`;
        return result;
      }
    }
  }

  // 7. Positive Keywords & Quantity Limits
  const posKeywords = Array.isArray(filters.positiveKeywords) ? filters.positiveKeywords : [];
  if (posKeywords.length > 0) {
    let matchedKw = null;
    for (const kw of posKeywords) {
      const kwText = String(kw?.text || kw || '').toLowerCase().trim();
      if (kwText && searchableText.includes(kwText)) {
        matchedKw = kw;
        break;
      }
    }

    if (!matchedKw) {
      result.rejectionReason = 'NO_POSITIVE_KEYWORD_MATCH';
      return result;
    }
    result.score += 20;

    // Quantity threshold check
    const requiredQty = matchedKw?.productQty || matchedKw?.qty;
    if (requiredQty && requiredQty > 1) {
      let leadQty = null;
      const isqList = Array.isArray(rawLead.isqDetails) ? rawLead.isqDetails : [];
      for (const item of isqList) {
        if (/quantity/i.test(String(item))) {
          const match = String(item).match(/\d+/);
          if (match) {
            leadQty = parseInt(match[0], 10);
            break;
          }
        }
      }
      if (leadQty !== null && leadQty < requiredQty) {
        result.rejectionReason = `QTY_BELOW_MINIMUM: ${leadQty} < ${requiredQty}`;
        return result;
      }
      result.score += 15;
    }
  }

  // 8. Contact Information Verification
  const contactText = `${rawLead.contactDetails || ''} ${rawText}`.toLowerCase();
  const hasPhoneAvailable = /mobile.*available|phone.*available|whatsapp.*available/i.test(contactText);
  const hasPhoneVerified = /mobile.*verified|phone.*verified|verified.*mobile/i.test(contactText);
  const hasEmailAvailable = /email.*available/i.test(contactText);
  const hasEmailVerified = /email.*verified|verified.*email/i.test(contactText);

  result.metrics.hasPhoneAvailable = hasPhoneAvailable || hasPhoneVerified;
  result.metrics.hasPhoneVerified = hasPhoneVerified;
  result.metrics.hasEmailAvailable = hasEmailAvailable || hasEmailVerified;
  result.metrics.hasEmailVerified = hasEmailVerified;

  const emailFilter = String(filters.emailFilter || 'OFF').toUpperCase().trim();
  const phoneFilter = String(filters.phoneFilter || 'OFF').toUpperCase().trim();
  const anyContactFilter = String(filters.anyContactFilter || 'OFF').toUpperCase().trim();

  if (emailFilter === 'AVAILABLE' && !hasEmailAvailable && !hasEmailVerified) {
    result.rejectionReason = 'EMAIL_NOT_AVAILABLE';
    return result;
  }
  if (emailFilter === 'VERIFIED' && !hasEmailVerified) {
    result.rejectionReason = 'EMAIL_NOT_VERIFIED';
    return result;
  }
  if (phoneFilter === 'AVAILABLE' && !hasPhoneAvailable && !hasPhoneVerified) {
    result.rejectionReason = 'PHONE_NOT_AVAILABLE';
    return result;
  }
  if (phoneFilter === 'VERIFIED' && !hasPhoneVerified) {
    result.rejectionReason = 'PHONE_NOT_VERIFIED';
    return result;
  }
  if (anyContactFilter === 'AVAILABLE' && !hasPhoneAvailable && !hasPhoneVerified && !hasEmailAvailable && !hasEmailVerified) {
    result.rejectionReason = 'NO_CONTACT_AVAILABLE';
    return result;
  }
  if (anyContactFilter === 'VERIFIED' && !hasPhoneVerified && !hasEmailVerified) {
    result.rejectionReason = 'NO_CONTACT_VERIFIED';
    return result;
  }
  if (anyContactFilter === 'AVAILABLE_AND_VERIFIED') {
    const availCount = (hasPhoneAvailable || hasPhoneVerified ? 1 : 0) + (hasEmailAvailable || hasEmailVerified ? 1 : 0);
    const verCount = (hasPhoneVerified ? 1 : 0) + (hasEmailVerified ? 1 : 0);
    if (availCount < 1 || verCount < 1) {
      result.rejectionReason = 'CONTACT_AVAILABLE_AND_VERIFIED_REQUIRED';
      return result;
    }
  }

  if (hasPhoneVerified) result.score += 10;
  if (hasEmailVerified) result.score += 5;

  // 9. Target Button State Verification
  const btn = rawLead.button;
  if (btn) {
    if (btn.disabled) {
      result.rejectionReason = 'BUTTON_DISABLED';
      return result;
    }
    const btnText = (btn.text || '').toLowerCase();
    if (/already|not\s*interested|thanks/i.test(btnText)) {
      result.rejectionReason = 'BUTTON_ALREADY_CONTACTED';
      return result;
    }
  }

  // ALL ALGORITHMS PASSED!
  result.matched = true;
  result.shouldClick = true;
  return result;
}

// -----------------------------------------------------------------------------
// 4. Protected Core Endpoint (POST /api/process)
// -----------------------------------------------------------------------------
app.post('/api/process', authenticateLicense, (req, res) => {
  const { payload, filters = {} } = req.body;

  if (!payload || !Array.isArray(payload)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid payload: Array of raw DOM elements expected.'
    });
  }

  try {
    const processedResults = [];
    let matchedCount = 0;
    let shouldClickCount = 0;

    for (const rawItem of payload) {
      const evaluated = evaluateLeadItem(rawItem, filters);
      if (evaluated.matched) {
        matchedCount++;
      }
      if (evaluated.shouldClick) {
        shouldClickCount++;
      }
      processedResults.push(evaluated);
    }

    // Sort: Matching leads with highest score first
    processedResults.sort((a, b) => {
      if (a.shouldClick && !b.shouldClick) return -1;
      if (!a.shouldClick && b.shouldClick) return 1;
      return b.score - a.score;
    });

    return res.status(200).json({
      success: true,
      tier: req.userTier,
      timestamp: new Date().toISOString(),
      summary: {
        totalReceived: payload.length,
        matchedCount,
        shouldClickCount
      },
      data: processedResults
    });
  } catch (err) {
    console.error('[POST /api/process Error]:', err);
    return res.status(500).json({
      success: false,
      error: 'Proprietary processing error: ' + err.message
    });
  }
});

// -----------------------------------------------------------------------------
// 5. License Activation & Registration Endpoints (Zero Client-Side Credentials)
// -----------------------------------------------------------------------------

function computeDurationExpiry(record) {
  const now = new Date();
  const directExpiry = record?.expires_at || record?.expiresAt || record?.expiration_date;
  if (directExpiry) {
    const parsed = new Date(directExpiry);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }

  let durationDays = 30;
  if (record?.duration_days) {
    durationDays = parseInt(record.duration_days, 10);
  } else if (record?.duration_months) {
    durationDays = parseInt(record.duration_months, 10) * 30;
  } else if (record?.duration) {
    const match = String(record.duration).match(/(\d+)\s*([a-zA-Z]+)?/);
    if (match) {
      const val = parseInt(match[1], 10);
      const unit = (match[2] || 'days').toLowerCase();
      durationDays = unit.startsWith('month') ? val * 30 : val;
    }
  }

  const expires = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
  return expires.toISOString();
}

app.post('/api/activate', async (req, res) => {
  const { licenseKey, email } = req.body;
  if (!licenseKey || typeof licenseKey !== 'string') {
    return res.status(400).json({ valid: false, message: 'License key is required.' });
  }

  const cleanKey = licenseKey.trim().toUpperCase();

  try {
    if (!supabaseLicenses) {
      return res.status(500).json({
        valid: false,
        message: 'Server configuration error: LICENSES_URL or LICENSES_KEY environment variables missing.'
      });
    }

    const { data: rows, error: qErr } = await supabaseLicenses
      .from('license_keys')
      .select('*')
      .eq('license_key', cleanKey)
      .limit(1);

    if (qErr) {
      return res.status(500).json({ valid: false, message: 'Database error: ' + qErr.message });
    }

    if (!rows || rows.length === 0) {
      return res.status(404).json({ valid: false, message: 'License key not found in system.' });
    }

    const record = rows[0];

    if (record.status && String(record.status).toLowerCase() === 'revoked') {
      return res.status(403).json({ valid: false, message: 'This license key has been revoked.' });
    }
    if (record.is_active === false || record.active === false) {
      return res.status(403).json({ valid: false, message: 'This license key is marked as inactive.' });
    }

    const expField = record.expires_at || record.expiresAt || record.expiration_date;
    if (expField) {
      const expTime = new Date(expField).getTime();
      if (!isNaN(expTime) && expTime < Date.now()) {
        return res.status(403).json({ valid: false, message: 'This license key expired on ' + new Date(expField).toLocaleDateString() });
      }
    }

    // Mark redeemed if not already redeemed
    if (!record.is_redeemed) {
      try {
        await supabaseLicenses
          .from('license_keys')
          .update({
            is_redeemed: true,
            redeemed_by: email || null,
            redeemed_at: new Date().toISOString()
          })
          .eq('id', record.id);
      } catch (e) {
        console.warn('[Activation update warning]:', e.message);
      }
    }

    const finalExpiry = computeDurationExpiry(record);

    return res.status(200).json({
      valid: true,
      tier: (record.tier || record.plan || 'ENTERPRISE').toUpperCase(),
      duration: record.duration || '30 days',
      duration_days: record.duration_days || 30,
      expires_at: finalExpiry,
      features: record.features || null
    });
  } catch (err) {
    return res.status(500).json({ valid: false, message: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { companyName, email, phone, licenseKey, tier } = req.body;
  const targetClient = supabaseCustomers || supabaseLicenses;

  if (!targetClient) {
    return res.status(500).json({ success: false, error: 'Database configuration missing on server.' });
  }

  try {
    const basePayload = {
      company_name: companyName || '',
      email: email || '',
      phone: phone || '',
      license_key: licenseKey || '',
      plan: tier || 'ENTERPRISE',
      activated_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    };

    // 1. Try key_registrations with standard company_name
    let { error: insErr } = await targetClient
      .from('key_registrations')
      .insert([basePayload]);

    // 2. If schema expects 'company' instead of 'company_name' (PGRST204)
    if (insErr && (insErr.code === 'PGRST204' || (insErr.message && insErr.message.includes('company_name')))) {
      const altPayload = {
        company: companyName || '',
        email: email || '',
        phone: phone || '',
        license_key: licenseKey || '',
        plan: tier || 'ENTERPRISE',
        activated_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      };
      const retry = await targetClient.from('key_registrations').insert([altPayload]);
      insErr = retry.error;
    }

    // 3. If table 'key_registrations' not found (PGRST205), try 'customers' table
    if (insErr && (insErr.code === 'PGRST205' || (insErr.message && insErr.message.includes('key_registrations')))) {
      const retryCust = await targetClient.from('customers').insert([basePayload]);
      insErr = retryCust.error;
    }

    if (insErr) {
      console.warn('[POST /api/register insert warning]:', insErr.message);
      return res.status(400).json({ success: false, error: insErr.message });
    }

    return res.status(200).json({ success: true, message: 'Customer registration saved successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[LeadPicker Server] Remote backend running on port ${PORT} on host 0.0.0.0`);
  console.log(`[LeadPicker Server] Health check endpoint: GET http://0.0.0.0:${PORT}/health`);
  console.log(`[LeadPicker Server] Processing endpoint: POST http://0.0.0.0:${PORT}/api/process`);
});
