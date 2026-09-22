// Synthetic, provider-neutral raw HTML snapshots. The embedded document is a
// fixture adapter contract, not a selector or a claim about a real provider.
const origin = 'https://fixture.example';

function html(document) {
  const payload = JSON.stringify(document).replaceAll('<', '\\u003c');
  return `<!doctype html><html><body><script id="fixture-document" type="application/json">${payload}</script></body></html>`;
}

function entry(path, document) { return { url: `${origin}${path}`, body: html(document) }; }

export function foundationCorpus({ faults = false } = {}) {
  const aLog = [
    { opponent: 'Fixture B', boxScoreUrl: '/box/one.html', status: 'final', homeScore: 70, awayScore: 65 },
    { opponent: 'Fixture B', boxScoreUrl: '/box/two.html', status: 'canceled' },
    { opponent: null, status: 'scheduled', note: 'unlinked opponent' },
  ];
  if (faults) aLog.push({ opponent: 'Outside', boxScoreUrl: 'https://outside.example/box/unsafe.html', status: 'scheduled' });
  const bLog = [
    { opponent: 'Fixture A', boxScoreUrl: '/box/one.html', status: 'final', homeScore: 70, awayScore: 65 },
    { opponent: 'Fixture A', boxScoreUrl: '/box/three.html', status: 'rescheduled' },
    { opponent: 'Fixture A', boxScoreUrl: '/box/four.html', status: 'final', homeScore: 80, awayScore: 78 },
    { opponent: 'Fixture A', boxScoreUrl: '/box/six.html', status: 'scheduled' },
  ];
  if (faults) bLog.push({ opponent: 'Shifted', boxScoreUrl: '/box/shift.html', status: 'scheduled' });
  return [
    entry('/cbb/schools/', { schools: [
      { path: '/school/a', name: 'Fixture A', to: 2026, historyUrl: '/school/a/men/' },
      { path: '/school/b', name: 'Fixture B', to: 2026, historyUrl: '/school/b/men/' },
      { path: '/school/c', name: 'Fixture C', to: 2025, historyUrl: '/school/c/men/' },
    ] }),
    entry('/school/a/men/', { seasons: [
      { endingYear: 2026, url: '/school/a/men/2026.html' },
      { endingYear: 2024, url: '/school/a/men/2024.html' },
    ] }),
    entry('/school/b/men/', { seasons: [{ endingYear: 2026, url: '/school/b/men/2026.html' }] }),
    entry('/school/a/men/2026.html', { school: 'Fixture A', endingYear: 2026, gameLogUrl: '/school/a/men/2026-gamelogs.html' }),
    entry('/school/a/men/2024.html', { school: 'Fixture A', endingYear: 2024, gameLogUrl: '/school/a/men/2024-gamelogs.html' }),
    entry('/school/b/men/2026.html', { school: 'Fixture B', endingYear: 2026, gameLogUrl: '/school/b/men/2026-gamelogs.html' }),
    entry('/school/a/men/2026-gamelogs.html', { games: aLog }),
    entry('/school/a/men/2024-gamelogs.html', { games: [{ opponent: 'Fixture B', boxScoreUrl: '/box/five.html', status: 'incomplete' }] }),
    entry('/school/b/men/2026-gamelogs.html', { games: bLog }),
    entry('/box/one.html', {
      date: '2026-01-02', home: 'Fixture A', away: 'Fixture B', homeScore: 70, awayScore: 65,
      winner: 'Fixture A', context: 'home', status: 'final', playerSourceId: null,
      valueStates: { blank: { state: 'blank' }, unavailable: { state: 'unavailable', reason: 'not_published' }, null: { state: 'null' }, zero: { state: 'present', value: 0 } },
    }),
    entry('/box/two.html', { date: '2026-01-03', home: 'Fixture A', away: 'Fixture B', homeScore: null, awayScore: null, context: 'away', status: 'canceled' }),
    entry('/box/three.html', { date: '2026-01-04', home: 'Fixture B', away: 'Fixture A', context: 'home', status: 'rescheduled' }),
    entry('/box/four.html', { date: '2026-01-05', home: 'Fixture B', away: 'Fixture A', homeScore: 80, awayScore: 78, winner: 'Fixture B', context: 'neutral', status: 'final', overtime: 2 }),
    entry('/box/five.html', { date: '2024-02-01', home: 'Fixture A', away: 'Fixture B', context: 'away', status: 'incomplete' }),
    entry('/box/six.html', { date: '2026-02-01', home: 'Fixture B', away: 'Fixture A', context: 'home', status: 'scheduled' }),
    ...(faults ? [entry('/box/shift.html', { layoutShift: true, status: 'scheduled', context: 'home' })] : []),
  ];
}
