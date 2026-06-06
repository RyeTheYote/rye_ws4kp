// TripIt travel forecast source.
//
// TripIt closed its public API to new keys (May 2024), so instead of the OAuth API this reads your
// private, read-only TripIt *calendar feed* (an iCal/.ics URL from Settings -> Calendar Feed). The feed
// URL is itself the secret, so it's kept server-side (env var TRIPIT_ICS_URL) and never sent to the
// browser. We parse the feed for all upcoming trips (in date order), resolve each destination to
// coordinates (using the event's GEO field when present, otherwise geocoding its location text via
// ArcGIS), and hand the list to the client, which fetches a weather.gov forecast for each just as it
// does for preset cities.
//
// For one row per trip, set the TripIt calendar feed to show "just the trip title" (Settings ->
// Calendar Feed) so each trip is a single VEVENT. The "all detailed plans" mode emits a VEVENT per
// flight/hotel segment; we merge date-overlapping segments back into a single trip as a safety net.

import https from 'https';

const ARCGIS_FIND_URL = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/find';
const USER_AGENT = 'Weatherstar 4000+; weatherstar@netbymatt.com';

// cache the parsed result so we don't refetch/geocode the feed on every client request
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
let cached = { time: 0, payload: null };

// minimal https GET returning the response body as a string (mirrors datagenerators/https.mjs),
// following the one redirect TripIt feeds sometimes issue
const httpsGet = (url, redirectsLeft = 3) => new Promise((resolve, reject) => {
	// TripIt feed URLs are commonly shared as webcal:// - treat them as https
	const httpsUrl = url.replace(/^webcal:\/\//i, 'https://');
	https.get(httpsUrl, { headers: { 'user-agent': USER_AGENT } }, (res) => {
		// follow redirects
		if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
			res.resume();
			resolve(httpsGet(new URL(res.headers.location, httpsUrl).toString(), redirectsLeft - 1));
			return;
		}
		const buffers = [];
		res.on('data', (data) => buffers.push(data));
		res.on('end', () => {
			const body = Buffer.concat(buffers).toString();
			if (res.statusCode >= 200 && res.statusCode < 300) {
				resolve(body);
			} else {
				reject(new Error(`Request failed: ${res.statusCode} ${body.slice(0, 200)}`));
			}
		});
	}).on('error', reject);
});

// unescape iCal text values (RFC 5545: \\ \, \; \n)
const unescapeIcs = (value) => value
	.replace(/\\n/gi, ' ')
	.replace(/\\([,;\\])/g, '$1');

// parse an iCal document into an array of VEVENTs with the fields we care about
const parseEvents = (ics) => {
	// unfold continuation lines (a leading space or tab continues the previous line)
	const unfolded = ics.replace(/\r?\n[ \t]/g, '');
	const lines = unfolded.split(/\r?\n/);

	const events = [];
	let current = null;
	lines.forEach((line) => {
		if (line === 'BEGIN:VEVENT') {
			current = {};
			return;
		}
		if (line === 'END:VEVENT') {
			if (current) events.push(current);
			current = null;
			return;
		}
		if (!current) return;

		const colon = line.indexOf(':');
		if (colon === -1) return;
		const key = line.slice(0, colon).split(';')[0].toUpperCase();
		const value = line.slice(colon + 1);

		if (key === 'DTSTART') current.start = value;
		else if (key === 'DTEND') current.end = value;
		else if (key === 'SUMMARY') current.summary = unescapeIcs(value);
		else if (key === 'LOCATION') current.location = unescapeIcs(value);
		else if (key === 'GEO') current.geo = value;
	});
	return events;
};

// the leading YYYYMMDD of an iCal date/date-time value, e.g. "20260615" - sorts and compares lexically
const dateKey = (value) => (value || '').replace(/[^0-9]/g, '').slice(0, 8);
// YYYYMMDD -> YYYY-MM-DD
const toIsoDate = (key) => (key.length === 8 ? `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}` : null);

// build the ordered list of upcoming trips: keep events that haven't ended yet (includes in-progress
// trips), sort by start date, then merge events whose dates overlap an existing trip window so a
// "detailed plans" feed (one VEVENT per segment) collapses to one entry per trip
const groupTrips = (events) => {
	const today = dateKey(new Date().toISOString());
	const upcoming = events
		.filter((e) => e.start && (dateKey(e.end || e.start) >= today))
		.sort((a, b) => dateKey(a.start).localeCompare(dateKey(b.start)));

	const trips = [];
	upcoming.forEach((e) => {
		const startK = dateKey(e.start);
		const endK = dateKey(e.end || e.start);
		const last = trips[trips.length - 1];
		if (last && startK <= last.endK) {
			// overlapping segment of the same trip - extend the window
			if (endK > last.endK) last.endK = endK;
			// prefer a representative event that actually carries a location/geo
			if (!last.event.location && !last.event.geo && (e.location || e.geo)) last.event = e;
		} else {
			trips.push({ startK, endK, event: e });
		}
	});
	return trips;
};

// geocode a free-text location to { latitude, longitude } via ArcGIS (the same service the app uses
// for its address search), or null on failure
const geocode = async (text) => {
	if (!text) return null;
	try {
		const url = `${ARCGIS_FIND_URL}?${new URLSearchParams({ text, f: 'json', maxLocations: '1' })}`;
		const data = JSON.parse(await httpsGet(url));
		const geometry = data?.locations?.[0]?.feature?.geometry;
		if (!geometry || !Number.isFinite(geometry.y) || !Number.isFinite(geometry.x)) return null;
		return { latitude: geometry.y, longitude: geometry.x };
	} catch (error) {
		console.error(`TripIt geocode error for "${text}": ${error.message}`);
		return null;
	}
};

// resolve a trip event's destination coordinates: prefer the iCal GEO field, then geocode the
// location text, then the summary text
const resolveCoords = async (event) => {
	if (event.geo) {
		const [lat, lon] = event.geo.split(';').map(Number);
		if (Number.isFinite(lat) && Number.isFinite(lon)) return { latitude: lat, longitude: lon };
	}
	const fromLocation = await geocode(event.location);
	if (fromLocation) return fromLocation;
	return geocode(event.summary);
};

// resolve a grouped trip into the client-facing shape, or null if it has no usable coordinates
const buildTrip = async ({ startK, endK, event }) => {
	const coords = await resolveCoords(event);
	if (!coords) return null;
	return {
		name: event.location || event.summary || 'Travel Destination',
		summary: event.summary || '',
		latitude: coords.latitude,
		longitude: coords.longitude,
		startDate: toIsoDate(startK),
		endDate: toIsoDate(endK),
	};
};

// Express handler: GET /tripit/trips.json -> { trips: [...] } in chronological order
const tripitTrips = async (req, res) => {
	const icsUrl = process.env.TRIPIT_ICS_URL;

	res.set('Content-Type', 'application/json');

	if (!icsUrl) {
		res.json({ trips: [], reason: 'not_configured' });
		return;
	}

	// serve a fresh cached result without refetching the feed
	if (cached.payload && (Date.now() - cached.time) < CACHE_TTL) {
		res.json(cached.payload);
		return;
	}

	try {
		const ics = await httpsGet(icsUrl);
		const grouped = groupTrips(parseEvents(ics));
		const resolved = await Promise.all(grouped.map(buildTrip));
		const trips = resolved.filter(Boolean);

		const payload = { trips };
		cached = { time: Date.now(), payload };
		res.json(payload);
	} catch (error) {
		console.error(`TripIt trips error: ${error.message}`);
		res.json({ trips: [], reason: 'error' });
	}
};

export {
	parseEvents,
	groupTrips,
	tripitTrips,
};
