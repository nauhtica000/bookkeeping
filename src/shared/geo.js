// Place names used for sales tax jurisdictions. Geography only — no tax rates
// are stored anywhere in this app.

export const OUTSIDE_US = 'INTL';

export const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
  ['PR', 'Puerto Rico'], ['VI', 'U.S. Virgin Islands'], ['GU', 'Guam'], ['AS', 'American Samoa'],
  ['MP', 'Northern Mariana Islands'], ['AA', 'Armed Forces Americas'], ['AE', 'Armed Forces Europe'],
  ['AP', 'Armed Forces Pacific'],
];

export const STATE_OPTIONS = [...US_STATES, [OUTSIDE_US, 'Outside the US']];

const STATE_NAME = new Map(STATE_OPTIONS);

export function stateName(code) {
  return STATE_NAME.get(code) ?? code ?? '';
}

export function isValidStateCode(code) {
  return STATE_NAME.has(code);
}

// Find a state code from a code or full name ("NY", "ny", "New York").
export function normalizeState(input) {
  if (!input) return null;
  const s = String(input).trim();
  const up = s.toUpperCase();
  if (STATE_NAME.has(up)) return up;
  for (const [code, name] of STATE_OPTIONS) {
    if (name.toLowerCase() === s.toLowerCase()) return code;
  }
  return null;
}

// New York's 62 counties. The five NYC boroughs are counties: Bronx, Kings
// (Brooklyn), New York (Manhattan), Queens, Richmond (Staten Island).
export const NY_COUNTIES = [
  'Albany', 'Allegany', 'Bronx', 'Broome', 'Cattaraugus', 'Cayuga', 'Chautauqua', 'Chemung',
  'Chenango', 'Clinton', 'Columbia', 'Cortland', 'Delaware', 'Dutchess', 'Erie', 'Essex',
  'Franklin', 'Fulton', 'Genesee', 'Greene', 'Hamilton', 'Herkimer', 'Jefferson', 'Kings',
  'Lewis', 'Livingston', 'Madison', 'Monroe', 'Montgomery', 'Nassau', 'New York', 'Niagara',
  'Oneida', 'Onondaga', 'Ontario', 'Orange', 'Orleans', 'Oswego', 'Otsego', 'Putnam',
  'Queens', 'Rensselaer', 'Richmond', 'Rockland', 'St. Lawrence', 'Saratoga', 'Schenectady',
  'Schoharie', 'Schuyler', 'Seneca', 'Steuben', 'Suffolk', 'Sullivan', 'Tioga', 'Tompkins',
  'Ulster', 'Warren', 'Washington', 'Wayne', 'Westchester', 'Wyoming', 'Yates',
];

export const NYC_BOROUGH_COUNTIES = ['Bronx', 'Kings', 'New York', 'Queens', 'Richmond'];

// Match a county name loosely ("suffolk", "Suffolk County", "Saint Lawrence").
export function normalizeNyCounty(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/\s+county$/, '').replace(/^saint\s+/, 'st. ').replace(/^st\s+/, 'st. ');
  const aliases = { brooklyn: 'Kings', manhattan: 'New York', 'staten island': 'Richmond', 'the bronx': 'Bronx' };
  if (aliases[s]) return aliases[s];
  return NY_COUNTIES.find((c) => c.toLowerCase() === s) ?? null;
}

export function jurisdictionLabel(state, county, locality) {
  if (state === OUTSIDE_US) return 'Outside the US';
  if (!county && !locality) return state ? `${stateName(state)} (${state})` : '(no state)';
  const parts = [];
  if (locality) parts.push(locality);
  if (county) parts.push(state === 'NY' || !/county$/i.test(county) ? `${county} County` : county);
  parts.push(state || '(no state)');
  return parts.join(', ');
}
