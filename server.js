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
// 2. Robust Duration & Expiration Parsing Helper
// -----------------------------------------------------------------------------
function computeDurationExpiry(record, activatedAtDate) {
  let baseDate = activatedAtDate ? new Date(activatedAtDate) : new Date();
  if (isNaN(baseDate.getTime())) baseDate = new Date();

  // If there is already a direct valid future expiration date
  const directExpiry = record?.expires_at || record?.expiresAt || record?.expiration_date;
  if (directExpiry) {
    const parsed = new Date(directExpiry);
    if (!isNaN(parsed.getTime()) && parsed.getTime() > baseDate.getTime()) {
      return parsed.toISOString();
    }
  }

  // 1. Explicit numerical columns
  if (record?.duration_years && !isNaN(parseInt(record.duration_years, 10)) && parseInt(record.duration_years, 10) > 0) {
    const d = new Date(baseDate.getTime());
    d.setFullYear(d.getFullYear() + parseInt(record.duration_years, 10));
    return d.toISOString();
  }

  if (record?.duration_months && !isNaN(parseInt(record.duration_months, 10)) && parseInt(record.duration_months, 10) > 0) {
    const d = new Date(baseDate.getTime());
    d.setMonth(d.getMonth() + parseInt(record.duration_months, 10));
    return d.toISOString();
  }

  if (record?.duration_days && !isNaN(parseInt(record.duration_days, 10)) && parseInt(record.duration_days, 10) > 0) {
    const d = new Date(baseDate.getTime());
    d.setDate(d.getDate() + parseInt(record.duration_days, 10));
    return d.toISOString();
  }

  // 2. Parse text string (e.g., "12 Month(s)", "12 months", "12M", "6 months", "1 Year", "1Y", "30 Days")
  const rawDurationStr = record?.duration || record?.plan_duration || record?.validity || '';
  if (rawDurationStr) {
    const str = String(rawDurationStr).trim().toLowerCase();
    const match = str.match(/(\d+)\s*([a-zA-Z\(\)]+)?/);
    if (match) {
      const num = parseInt(match[1], 10);
      const unit = (match[2] || '').toLowerCase();
      if (!isNaN(num) && num > 0) {
        const d = new Date(baseDate.getTime());
        if (unit.includes('year') || unit.includes('yr') || unit === 'y' || str.includes('year')) {
          d.setFullYear(d.getFullYear() + num);
          return d.toISOString();
        } else if (unit.includes('month') || unit.includes('mon') || unit === 'm' || str.includes('month')) {
          d.setMonth(d.getMonth() + num);
          return d.toISOString();
        } else if (unit.includes('day') || unit.includes('d') || str.includes('day')) {
          d.setDate(d.getDate() + num);
          return d.toISOString();
        } else {
          if (num <= 12) {
            d.setMonth(d.getMonth() + num);
          } else {
            d.setDate(d.getDate() + num);
          }
          return d.toISOString();
        }
      }
    }
  }

  // 3. License key prefix/pattern fallback (e.g. PRO-12M-..., ENTERPRISE-6M-..., PRO-1Y-...)
  const keyStr = String(record?.license_key || record?.key || '').toUpperCase();
  if (keyStr) {
    const d = new Date(baseDate.getTime());
    const mMatch = keyStr.match(/-(\d+)\s*M(?:ONTH)?-/i) || keyStr.match(/-(\d+)M\b/i);
    if (mMatch && mMatch[1]) {
      const months = parseInt(mMatch[1], 10);
      if (!isNaN(months) && months > 0) {
        d.setMonth(d.getMonth() + months);
        return d.toISOString();
      }
    }

    const yMatch = keyStr.match(/-(\d+)\s*Y(?:EAR)?-/i) || keyStr.match(/-(\d+)Y\b/i);
    if (yMatch && yMatch[1]) {
      const years = parseInt(yMatch[1], 10);
      if (!isNaN(years) && years > 0) {
        d.setFullYear(d.getFullYear() + years);
        return d.toISOString();
      }
    }

    const dMatch = keyStr.match(/-(\d+)\s*D(?:AY)?-/i) || keyStr.match(/-(\d+)D\b/i);
    if (dMatch && dMatch[1]) {
      const days = parseInt(dMatch[1], 10);
      if (!isNaN(days) && days > 0) {
        d.setDate(d.getDate() + days);
        return d.toISOString();
      }
    }
  }

  // 4. Default fallback: 30 days
  const fallbackDate = new Date(baseDate.getTime());
  fallbackDate.setDate(fallbackDate.getDate() + 30);
  return fallbackDate.toISOString();
}

// -----------------------------------------------------------------------------
// 3. License Authentication Middleware (authenticateLicense)
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
    if (license.is_redeemed === false && license.status === 'available') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: License key has not been activated or redeemed.'
      });
    }

    // B. Query key_registrations to verify activated_at & subscription expiration
    let activatedAt = license.activated_at || license.redeemed_at || license.created_at;
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

    // Compute expiration date using shared robust helper
    if (!expiresAt) {
      expiresAt = computeDurationExpiry(license, activatedAt || new Date());
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

app.post('/api/activate', async (req, res) => {
  const { licenseKey, email, companyName, company, phone, tier } = req.body;
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

    const nowIso = new Date().toISOString();
    const finalExpiry = computeDurationExpiry(record, new Date());

    // Update license_keys to mark as REDEEMED and save expiration
    const updatePayload = {
      is_redeemed: true,
      status: 'redeemed',
      redeemed_by: email || null,
      redeemed_at: nowIso,
      activated_at: nowIso,
      expires_at: finalExpiry
    };

    // First attempt: full update
    const { error: updErr1 } = await supabaseLicenses
      .from('license_keys')
      .update(updatePayload)
      .eq('license_key', cleanKey);

    if (updErr1) {
      console.warn('[Activation full update warning]:', updErr1.message);
      // Fallback: minimal safe update for is_redeemed & status
      const minPayload = {
        is_redeemed: true,
        status: 'redeemed'
      };
      if (email) minPayload.redeemed_by = email;

      const { error: updErr2 } = await supabaseLicenses
        .from('license_keys')
        .update(minPayload)
        .eq('license_key', cleanKey);

      if (updErr2) {
        console.warn('[Activation minimal update warning]:', updErr2.message);
        // Fallback: just is_redeemed
        await supabaseLicenses
          .from('license_keys')
          .update({ is_redeemed: true })
          .eq('license_key', cleanKey);
      }
    }

    // Auto-sync registration into key_registrations if customer details were provided
    if (email || companyName || company) {
      const regClient = supabaseCustomers || supabaseLicenses;
      if (regClient) {
        syncKeyRegistration(regClient, {
          licenseKey: cleanKey,
          companyName: companyName || company || '',
          email: email || '',
          phone: phone || '',
          tier: record.tier || tier || 'PRO'
        }).catch((e) => console.warn('[Auto-sync registration during activation warning]:', e.message));
      }
    }

    const daysRemaining = Math.max(1, Math.ceil((new Date(finalExpiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

    return res.status(200).json({
      valid: true,
      tier: (record.tier || record.plan || 'ENTERPRISE').toUpperCase(),
      duration: record.duration || record.plan_duration || '12 Month(s)',
      duration_days: record.duration_days || daysRemaining,
      expires_at: finalExpiry,
      days_remaining: daysRemaining,
      features: record.features || null
    });
  } catch (err) {
    return res.status(500).json({ valid: false, message: err.message });
  }
});

// -----------------------------------------------------------------------------
// Helper: Multi-Database Registration Synchronizer
// Primary target: key_registrations (with isolated optional sync to customers)
// -----------------------------------------------------------------------------
async function syncKeyRegistration(client, regData) {
  if (!client) return { success: false, error: 'Database client not configured' };

  const cleanKey = String(regData.licenseKey || regData.key || '').trim().toUpperCase();
  const companyName = String(regData.companyName || regData.company || '').trim();
  const email = String(regData.email || '').trim();
  const phone = String(regData.phone || '').trim();
  const tier = String(regData.tier || regData.plan || 'PRO').toUpperCase();
  const nowIso = new Date().toISOString();

  // Helper to check if error indicates already registered (unique constraint violation)
  const isDuplicateError = (err) => err && (
    err.code === '23505' ||
    String(err.message || '').toLowerCase().includes('duplicate') ||
    String(err.message || '').toLowerCase().includes('unique constraint')
  );

  // Full payload with all alias fields populated
  const payload = {
    license_key: cleanKey,
    key: cleanKey,             // Some dashboards check 'key' instead of 'license_key'
    company_name: companyName,
    company: companyName,      // Ensure both variants exist
    email: email,
    phone: phone,
    plan: tier,
    tier: tier,
    activated_at: nowIso,
    created_at: nowIso
  };

  let registeredOk = false;
  let lastError = null;

  // 1. Primary Target: key_registrations
  try {
    const { error: err1 } = await client.from('key_registrations').insert([payload]);
    if (!err1 || isDuplicateError(err1)) {
      registeredOk = true;
    } else {
      console.warn('[syncKeyRegistration key_registrations full payload warning]:', err1.message);
      lastError = err1.message;

      // Retry with standard snake_case columns
      const fallbackPayload = {
        license_key: cleanKey,
        company_name: companyName,
        email: email,
        phone: phone,
        plan: tier,
        activated_at: nowIso
      };
      const { error: err2 } = await client.from('key_registrations').insert([fallbackPayload]);
      if (!err2 || isDuplicateError(err2)) {
        registeredOk = true;
      } else {
        console.warn('[syncKeyRegistration key_registrations fallback warning]:', err2.message);
        lastError = err2.message;

        // Retry with alt columns (key, company, tier)
        const altPayload = {
          key: cleanKey,
          company: companyName,
          email: email,
          phone: phone,
          tier: tier,
          activated_at: nowIso
        };
        const { error: err3 } = await client.from('key_registrations').insert([altPayload]);
        if (!err3 || isDuplicateError(err3)) {
          registeredOk = true;
        } else {
          lastError = err3.message;
        }
      }
    }
  } catch (errKeyReg) {
    lastError = errKeyReg.message;
    console.warn('[syncKeyRegistration key_registrations exception]:', errKeyReg.message);
  }

  // 2. Safe Optional Sync: customers table (isolated in its own try/catch so it never breaks registration)
  try {
    await client.from('customers').insert([payload]);
  } catch (custErr) {
    console.warn('[syncKeyRegistration customers optional sync notice]:', custErr.message);
  }

  if (registeredOk) {
    return { success: true, table: 'key_registrations' };
  }

  return { success: false, error: lastError || 'Failed to insert into key_registrations' };
}

app.post('/api/register', async (req, res) => {
  const { companyName, company, email, phone, licenseKey, key, tier, plan } = req.body;
  const rawKey = licenseKey || key;

  if (!rawKey) {
    return res.status(400).json({ success: false, error: 'licenseKey is required.' });
  }

  const cleanKey = String(rawKey).trim().toUpperCase();
  const cName = String(companyName || company || '').trim();
  const cEmail = String(email || '').trim();
  const cPhone = String(phone || '').trim();
  const cTier = String(tier || plan || 'PRO').toUpperCase();

  const regData = {
    licenseKey: cleanKey,
    key: cleanKey,
    companyName: cName,
    company: cName,
    email: cEmail,
    phone: cPhone,
    tier: cTier,
    plan: cTier
  };

  const results = [];

  // Primary: supabaseCustomers client (or fallback supabaseLicenses)
  const primaryClient = supabaseCustomers || supabaseLicenses;
  if (primaryClient) {
    const resPrimary = await syncKeyRegistration(primaryClient, regData);
    results.push({ target: 'supabaseCustomers', ...resPrimary });
  }

  // Also sync to supabaseLicenses if separate
  if (supabaseLicenses && supabaseLicenses !== primaryClient) {
    const resLic = await syncKeyRegistration(supabaseLicenses, regData);
    results.push({ target: 'supabaseLicenses', ...resLic });
  }

  const isSuccess = results.some(r => r.success);

  if (isSuccess) {
    console.log(`[POST /api/register] Successfully registered key ${cleanKey}:`, results);
    return res.status(200).json({
      success: true,
      message: 'Registration saved',
      key: cleanKey,
      details: results
    });
  }

  console.error(`[POST /api/register failure for ${cleanKey}]:`, results);
  return res.status(400).json({
    success: false,
    error: results[0]?.error || 'Failed to record registration in database.',
    details: results
  });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[LeadPicker Server] Remote backend running on port ${PORT} on host 0.0.0.0`);
  console.log(`[LeadPicker Server] Health check endpoint: GET http://0.0.0.0:${PORT}/health`);
  console.log(`[LeadPicker Server] Processing endpoint: POST http://0.0.0.0:${PORT}/api/process`);
});
