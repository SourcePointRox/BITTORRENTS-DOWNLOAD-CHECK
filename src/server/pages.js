'use strict';
/* SSR 页面层：与 iknowwhatyoudownload.com 页面结构/样式对齐（Bootstrap 3 体系），
   并在 peer/torrent 页增强展示 infohash / magnet / 最早记录发布时间。 */
const db = require('./db');
const geo = require('./geo');
const { esc, formatSize, fmtUTC, fmtDay, magnetURI, slugify, isIPv4 } = require('../common/util');

/* ---------- 布局 ---------- */
function layout({ title, description, content, headExtra = '', bodyExtra = '' }) {
  return `<!DOCTYPE html>
<html>
<head>
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description || title)}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/assets/css/bootstrap.min.css">
<link rel="stylesheet" href="/assets/css/bootstrap-theme.min.css">
<link rel="stylesheet" href="/assets/css/font-awesome.min.css">
<link href="/assets/css/v2.css" rel="stylesheet">
<link rel="icon" type="image/svg+xml" href="/assets/img/logo.svg" />
<script src="/assets/js/jquery.min.js"></script>
<script src="/assets/js/bootstrap.min.js"></script>
<script src="/assets/js/chart.bundle.min.js"></script>
<script src="/assets/js/iknow.js"></script>
<meta http-equiv="content-type" content="text/html;charset=UTF-8">
${headExtra}</head>
<body>
<script>
    $(document).ready(function() {
        $('a[href="' + this.location.pathname + '"]').parent().addClass('active');
    });
</script>
<nav class="navbar navbar-default" itemscope itemtype="http://www.schema.org/SiteNavigationElement">
    <div class="container-fluid">
        <div class="navbar-header">
            <a class="navbar-brand" href="/">
                <img alt="Brand" src="/assets/img/logo.svg" width="110" height="24">
            </a>
            <button type="button" class="navbar-toggle collapsed" data-toggle="collapse" data-target="#bs-example-navbar-collapse-1" aria-expanded="false">
                <span class="sr-only">Toggle navigation</span>
                <span class="icon-bar"></span>
                <span class="icon-bar"></span>
                <span class="icon-bar"></span>
            </button>
        </div>
        <div class="collapse navbar-collapse" id="bs-example-navbar-collapse-1">
            <ul class="nav navbar-nav">
                <li itemprop="name"><a itemprop="url" href="/en/peer/">IP Info</a></li>
                <li itemprop="name"><a itemprop="url" href="/en/link/">Track Downloads</a></li>
                <li itemprop="name"><a itemprop="url" href="/en/stat/daily">Daily Statistics</a></li>
                <li itemprop="name"><a itemprop="url" href="/en/stat/annual">Annual Statistics</a></li>
                <li itemprop="name"><a itemprop="url" href="/en/api/">API</a></li>
                <li itemprop="name"><a itemprop="url" href="/en/contacts/">About Us</a></li>
            </ul>
            <form class="navbar-form navbar-left" action="/en/peer/">
                <div class="form-group">
                    <input type="text" class="form-control" placeholder="127.0.0.1" name="ip">
                </div>
                <button type="submit" class="btn btn-default">Find IP</button>
            </form>
            <ul class="nav navbar-nav navbar-right">
                <li><a id="lang" href="#">
                    <span class="bfh-languages" data-language="ru_RU" data-flags="true">RU</span>
                </a></li>
            </ul>
        </div><!-- /.navbar-collapse -->
    </div><!-- /.container-fluid -->
</nav>
<div class="container" id="main">
${content}
</div>

<footer class="footer" id="footer">
    <div class="container">
        <div class="row"></div>
        <div class="row">
            <div class="col-xs-12">
                <p>
                <div class="col-md-12 text-center">
                    <a class="twitter-follow-button" href="https://twitter.com/iknowtorrents" data-size="large">Follow Us</a>
                </div>
                </p>
            </div>
        </div>
    </div>
</footer>
${bodyExtra}
</body>
</html>`;
}

/* ---------- 公共片段 ---------- */
const MAGNET_ICON = '<i class="fa fa-magnet"></i>';

function copyBtn(text, title) {
  return `<button class="btn btn-default btn-xs magnet-btn" data-clipboard="${esc(text)}" title="${esc(title || 'Copy magnet link')}">${MAGNET_ICON}</button>`;
}

function hashCell(infohash) {
  return `<span class="infohash hash-cell" title="${infohash}">${infohash.slice(0, 12)}&hellip;</span>` +
    `<button class="btn btn-default btn-xs hash-copy" data-clipboard="${infohash}" title="Copy infohash"><i class="fa fa-clipboard"></i></button>`;
}

function geoLabels(g) {
  return [g.continent, g.country, g.city, g.isp]
    .filter(Boolean)
    .map(x => `<span class="label label-primary">${esc(x)}</span>`)
    .join('\n                    ');
}

const COPY_SCRIPT = `
<script>
document.addEventListener('click', function (e) {
  var btn = e.target.closest && e.target.closest('[data-clipboard]');
  if (!btn) return;
  var text = btn.getAttribute('data-clipboard');
  function ok() {
    btn.classList.add('btn-success');
    setTimeout(function(){ btn.classList.remove('btn-success'); }, 800);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok, function(){ fallbackCopy(text); ok(); });
  } else { fallbackCopy(text); ok(); }
});
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch(e) {}
  document.body.removeChild(ta);
}
</script>`;

/* ---------- 1. Peer 页（核心页，含增强列） ---------- */
function pagePeer(ip, visitorIp) {
  const d = db.get();
  if (!isIPv4(ip)) return page404('Invalid IP address');
  const g = geo.lookup(ip);

  const rows = d.prepare(`
    SELECT o.infohash, o.first_seen AS pair_first, o.last_seen AS pair_last,
           t.name, t.size, t.category, t.title, t.imdb_id, t.first_seen AS t_first
    FROM observations o JOIN torrents t ON t.infohash = o.infohash
    WHERE o.ip = ?
    ORDER BY o.last_seen DESC LIMIT 200`).all(ip);

  // 相似 IP：同 /24 中有记录的其他 IP
  const prefix = ip.split('.').slice(0, 3).join('.') + '.';
  const similar = d.prepare(`SELECT ip FROM peers WHERE ip LIKE ? AND ip != ? ORDER BY last_seen DESC LIMIT 10`)
    .all(prefix + '%', ip).map(r => r.ip);

  const isYou = ip === visitorIp;
  const tableRows = rows.map(r => {
    const magnet = magnetURI(r.infohash, r.name);
    const tlink = `/en/torrent/${r.infohash}/${slugify(r.name || r.infohash)}`;
    return `<tr>
        <td class="date-column">${fmtUTC(r.pair_first)}</td>
        <td class="date-column">${fmtUTC(r.pair_last)}</td>
        <td class="category-column">${esc(r.category || 'Unsorted')}</td>
        <td class="name-column"><a href="${tlink}">${esc(r.name || r.infohash)}</a></td>
        <td class="size-column">${formatSize(r.size)}</td>
        <td class="date-column published-column" title="UTC datetime when this torrent was first recorded in the network">${fmtUTC(r.t_first)}</td>
        <td class="hash-td">${hashCell(r.infohash)}</td>
        <td class="magnet-td">${copyBtn(magnet)}</td>
    </tr>`;
  }).join('\n');

  const empty = rows.length === 0
    ? `<div class="alert alert-info top15">We have no data about torrents downloaded by this IP address yet.</div>` : '';

  const content = `
    <div class="row">
        <div class="panel panel-default col-md-12">
            <div class="panel-body" itemscope itemtype="http://schema.org/Table">
                <div>
                    <h3 itemprop="about">Torrent downloads and distributions for IP ${esc(ip)}</h3>
                </div>

                <div>
                    ${geoLabels(g)}
                </div>

                ${isYou ? `<div class="padding-block">
                    ${esc(ip)} is your IP address.<br/>
                    <span class="grey-text">Computers connected to a network are assigned a unique number known as IP Address.
IP addresses consist of four numbers in the range 0-255 separated by periods (i.e. 166.70.177.128). A computer may have either a permanent (static) IP address, or one that is dynamically assigned/leased to it.</span>
                </div>` : ''}

                <div class="padding-block">
                    Use internet connection of other people (Wi Fi, their computers, tablets and smartphones) to know what they download in torrent network,
                    <a class="bold-links" href="/en/link/">spy on them via special generated link</a> or see other similar IPs:
                    ${similar.map(s => `<a class="bold-links" href="/en/peer/?ip=${s}">${s}</a>`).join('\n                        ') || '<span class="grey-text">none yet</span>'}
                </div>

                <div class="padding-block">
${empty}
<table class="table table-condensed table-striped">
    <thead class="header-torrents">
    <tr>
        <th title="UTC datetime when we saw user sharing torrent first time">First seen (UTC)</th>
        <th title="UTC datetime when we saw user sharing torrent last time. Site shows data with one day delay">Last seen (UTC)</th>
        <th title="Category of content">Category</th>
        <th title="Title of content or torrent file">Title</th>
        <th title="Size of content">Size</th>
        <th title="UTC datetime when this torrent was first recorded (earliest known publish time)">Published (UTC)</th>
        <th title="Torrent info hash (click to copy)">Info hash</th>
        <th title="Magnet link (click to copy)">Magnet</th>
    </tr>
    </thead>
    <tbody>
${tableRows}
    </tbody>
</table>                </div>
            </div>
        </div>
    </div>`;
  return layout({
    title: `Torrent downloads and distributions for IP ${ip}`,
    description: `Detailed statistic for torrent downloads and distributions for IP address ${ip}`,
    content,
    bodyExtra: COPY_SCRIPT,
  });
}

/* ---------- 2. Track Downloads ---------- */
function pageLink(generated) {
  const content = `
<div class="panel panel-default col-md-12">
    <div class="panel-body">
        <div>
            <h2>Track downloads</h2>
        </div>
        <form class="padding-block" method="post" action="/en/link/">
            <div class="form-group">
                <div class="col-xs-7">
                    <input type="url" class="form-control" id="link" name="url"
                           placeholder="Link to share with your friend (f.e., http://facebook.com)">
                </div>
                <div class="col-xs-2">
                    <button type="submit" class="btn btn-default">Transform</button>
                </div>
            </div>
        </form>
        ${generated || ''}
        <div class="padding-block col-md-12">
            <h3>How it works</h3>
            <ul class="padding-block">
                <li>Input link to share with your friend</li>
                <span class="grey-text">It could be some news page or post in social networks, some funny picture or adrress of ony site.</span>
                <li>Transform link and send it to your friend</li>
                <span class="grey-text">F.e. via Facebook/Telegram/Skype or any other messanger. When your friend will click on generated link he will be redirected to first link.</span>
                <li>You can see what he downloads in bittorrent network</li>
            </ul>
        </div>
    </div>
</div>`;
  return layout({ title: 'Track downloads', description: 'Track downloads via special link', content });
}

function pageLinkResult(token, targetUrl) {
  const link = `/link/go/${token}`;
  const gen = `
        <div class="padding-block col-md-12">
            <div class="alert alert-success">
                <p>Send this link to your friend: <a class="bold-links" href="${link}" target="_blank" id="spyLink">${esc(absoluteUrl(link))}</a>
                <button class="btn btn-default btn-xs" data-clipboard="${esc(absoluteUrl(link))}"><i class="fa fa-clipboard"></i></button></p>
                <p class="grey-text">Waiting for visit... this page refreshes automatically when the link is opened.</p>
                <div id="visitResult"></div>
            </div>
        </div>
        <script>
        (function poll(){
          fetch('/link/check/${token}').then(r=>r.json()).then(function(d){
            if (d.visited) {
              document.getElementById('visitResult').innerHTML =
                '<p><b>Visited!</b> Visitor IP: <a href="/en/peer/?ip=' + d.visitorIp + '">' + d.visitorIp + '</a> — see what they download.</p>';
            } else { setTimeout(poll, 3000); }
          }).catch(function(){ setTimeout(poll, 5000); });
        })();
        </script>`;
  return pageLink(gen);
}

function absoluteUrl(p) {
  const base = process.env.IKWYD_BASE_URL || 'http://localhost:8080';
  return base.replace(/\/$/, '') + p;
}

/* ---------- 3. 日统计页 ---------- */
function pageStatDaily(cc, day) {
  const d = db.get();
  cc = (cc || 'GL').toUpperCase();
  const latest = latestDay();
  day = day || latest;
  const prev = fmtDay(Date.parse(day + 'T00:00:00Z') - 86400000);
  const nextDate = Date.parse(day + 'T00:00:00Z') + 86400000;
  const next = nextDate < Date.parse(latest + 'T00:00:00Z') + 86400000 ? fmtDay(nextDate) : null;

  // GL = Global（全球汇总，非单一国家）
  const isGlobal = cc === 'GL';
  let peers = 0, perMillion = 0, pctInternetUsers = 0;
  if (isGlobal) {
    peers = d.prepare('SELECT COALESCE(SUM(peers),0) AS p FROM country_daily WHERE day=?').get(day).p;
    const totalPop = 8000; // 全球人口约 80 亿
    perMillion = Math.round(peers / (totalPop * 1e6) * 1e6);
    pctInternetUsers = (peers / (totalPop * 1e6 * 0.65) * 100); // 全球约 65% 网络普及率
  } else {
    const peersToday = d.prepare('SELECT peers FROM country_daily WHERE cc=? AND day=?').get(cc, day);
    peers = peersToday ? peersToday.peers : 0;
    const popMln = geo.populationOf(cc);
    const penetration = geo.penetrationOf(cc);
    perMillion = popMln ? Math.round(peers / (popMln * 1e6) * 1e6) : 0;
    pctInternetUsers = popMln ? (peers / (popMln * 1e6 * penetration) * 100) : 0;
  }

  // 饼图：该国家当日各类别下载（简化为全局类别分布，与官网视觉一致）
  const pieRows = d.prepare('SELECT category, downloads FROM daily_stats WHERE day=? ORDER BY downloads DESC').all(day);
  const totalDl = pieRows.reduce((a, r) => a + r.downloads, 0) || 1;
  const COLORS = { Movies: '#36a2eb', XXX: '#ff6384', Software: '#ff9f40', Music: '#4bc0c0', Games: '#9966ff', TV: '#36a2eb', Anime: '#4bc0c0', Books: '#c9cbcf', Unsorted: '#c9cbcf' };
  const pieLabels = pieRows.map(r => `${r.category} ${Math.round(r.downloads / totalDl * 100)}%`);
  const pieData = pieRows.map(r => r.downloads);
  const pieColors = pieRows.map(r => COLORS[r.category] || '#c9cbcf');

  // Top 列表（tabs）
  const TABS = [
    ['general', 'Top Torrents', null],
    ['movie', 'Top Movies', 'Movies'],
    ['xxx', 'Top XXX', 'XXX'],
    ['games', 'Top Games', 'Games'],
    ['software', 'Top Software', 'Software'],
    ['music', 'Top Music', 'Music'],
  ];
  function topList(cat) {
    let rows;
    if (cat) {
      rows = d.prepare(`SELECT td.infohash, td.peers, t.name, t.category FROM torrent_daily td
                        JOIN torrents t ON t.infohash = td.infohash
                        WHERE td.day=? AND t.category=? ORDER BY td.peers DESC LIMIT 12`).all(day, cat);
    } else {
      rows = d.prepare(`SELECT td.infohash, td.peers, t.name, t.category FROM torrent_daily td
                        JOIN torrents t ON t.infohash = td.infohash
                        WHERE td.day=? ORDER BY td.peers DESC LIMIT 12`).all(day);
    }
    return rows.map(r => `<li>
                                <a href="/en/torrent/${r.infohash}/${slugify(r.name || r.infohash)}">${esc(r.name || r.infohash)}</a>
                            </li>`).join('\n                            ');
  }
  const tabsNav = TABS.map(([id, label], i) =>
    `<li class="nav-item${i === 0 ? ' active' : ''}">
                    <a class="nav-link" data-toggle="tab" href="#${id}" role="tab">${label}</a>
                </li>`).join('\n                ');
  const tabsBody = TABS.map(([id, , cat], i) =>
    `<div class="tab-pane${i === 0 ? ' active' : ''}" id="${id}" role="tabpanel">
                    <ul>
${topList(cat) || '                            <li><span class="grey-text">No data</span></li>'}
                    </ul>
                </div>`).join('\n                ');

  // Top 12 Movies / Series 海报墙
  function posterWall(cat) {
    const rows = d.prepare(`
      SELECT t.imdb_id, t.title, COUNT(DISTINCT l.ip) AS peers
      FROM obs_log l JOIN torrents t ON t.infohash = l.infohash
      WHERE l.ts >= ? AND l.ts < ? AND t.category = ? AND t.imdb_id IS NOT NULL
      GROUP BY t.imdb_id ORDER BY peers DESC LIMIT 12`)
      .all(Date.parse(day + 'T00:00:00Z'), Date.parse(day + 'T00:00:00Z') + 86400000, cat);
    return rows.map(r => `
            <div class="col-xs-6 col-sm-4 col-md-3 col-lg-2 col-xl-2">
                <figure class="paddingBottom">
                    <a href="https://www.imdb.com/title/${esc(r.imdb_id)}/" rel="nofollow" target="_blank">
                        <div class="img-container">
                            <img src="/poster/${esc(r.imdb_id)}?t=${encodeURIComponent(r.title || '')}" alt="${esc(r.title || '')}" width="160" height="240">
                        </div>
                    </a>
                    <figcaption>
                        <a href="https://www.imdb.com/title/${esc(r.imdb_id)}/" class="movieTitle" rel="nofollow" target="_blank">
                            ${esc(r.title || '')}
                        </a>
                    </figcaption>
                </figure>
            </div>`).join('\n');
  }

  const countryOptions = geo.allCountries().map(c =>
    `<li><a href="/en/stat/${c.cc}/daily">${esc(c.country)}</a></li>`).join('\n                        ');

  // 国家名显示：GL 显示 Global
  const displayName = isGlobal ? 'Global' : geo.countryName(cc);

  const content = `
    <div class="row">
        <div class="column-md-12">
            <h3 class="paddingBottom">Daily Torrents Statistics in
                <a href="#" data-toggle="modal" data-target="#countryModal">${esc(displayName)}</a>
                for
                ${day > prev ? '' : ''}<small><a class="countryLink" href="/en/stat/${cc}/daily/q?statDate=${prev}">${prev}</a></small>
                <a href="#" data-toggle="modal" data-target="#dayModal">${day}</a>
                ${next ? `<small><a class="countryLink" href="/en/stat/${cc}/daily/q?statDate=${next}">${next}</a></small>` : ''}
            </h3>
        </div>
    </div>

    <div class="row paddingBottom">
            <div class="col-xs-12 col-sm-4 col-md-4 col-lg-3">
                <span class="usePercent">${perMillion}</span><br/>
                <span>per million population download Torrents daily</span>
            </div>
            <div class="col-xs-12 col-sm-4 col-md-4 col-lg-3">
                <span class="usePercent">${(penetration * 100).toFixed(2)}%</span><br/>
                <span>of population have Internet</span>
            </div>
            <div class="col-xs-12 col-sm-4 col-md-4 col-lg-3">
                <span class="usePercent">${pctInternetUsers.toFixed(2)}%</span><br/>
                <span>of Internet users download Torrents daily</span>
            </div>
    </div>

    <div class="row">
        <div class="col-xs-12 col-sm-6 col-md-4 col-lg-4">
            <canvas id="chart-area"></canvas>
        </div>
        <div class="col-xs-12 col-sm-12 col-md-8 col-lg-8">
            <ul class="nav nav-pills" role="tablist">
                ${tabsNav}
            </ul>
            <div id="topTorrents" class="tab-content">
                ${tabsBody}
            </div>
        </div>
    </div>

    <div class="row">
        <div class="column-md-12">
            <h3 class="paddingBottom">Top 12 Movies in <a href="#" data-toggle="modal" data-target="#countryModal">${esc(displayName)}</a>
                for ${day}</h3>
        </div>
    </div>
    <div class="row">
${posterWall('Movies') || '<p class="grey-text left15">No movie data for this day</p>'}
    </div>

    <div class="row">
        <div class="column-md-12">
            <h3 class="paddingBottom paddingTop">Top 12 Series in <a href="#" data-toggle="modal" data-target="#countryModal">${esc(displayName)}</a>
                for ${day}</h3>
        </div>
    </div>
    <div class="row">
${posterWall('TV') || '<p class="grey-text left15">No series data for this day</p>'}
    </div>

    <!-- 国家选择 -->
    <div class="modal fade" id="countryModal" tabindex="-1" role="dialog">
      <div class="modal-dialog" role="document">
        <div class="modal-content">
          <div class="modal-header"><button type="button" class="close" data-dismiss="modal">&times;</button>
            <h4 class="modal-title">Choose country</h4></div>
          <div class="modal-body">
            <input type="text" class="form-control" id="filterCountry" placeholder="Filter" onkeyup="onFilterCountry()">
            <ul id="countryUL" class="top10 country-list">
                        ${countryOptions}
            </ul>
          </div>
        </div>
      </div>
    </div>
    <!-- 日期选择 -->
    <div class="modal fade" id="dayModal" tabindex="-1" role="dialog">
      <div class="modal-dialog" role="document">
        <div class="modal-content">
          <div class="modal-header"><button type="button" class="close" data-dismiss="modal">&times;</button>
            <h4 class="modal-title">Choose date</h4></div>
          <div class="modal-body">
            <form method="get" action="/en/stat/${cc}/daily/q">
              <input type="date" class="form-control" name="statDate" value="${day}" max="${latest}" min="2019-11-18">
              <button type="submit" class="btn btn-primary top10">Go</button>
            </form>
          </div>
        </div>
      </div>
    </div>`;

  const bodyExtra = `
<script>
window.chartColors = { blue: '#36a2eb', red: '#ff6384', orange: '#ff9f40', green: '#4bc0c0', purple: '#9966ff', grey: '#c9cbcf' };
$(function () {
    var ctx = document.getElementById("chart-area").getContext("2d");
    var config = {
        type: 'pie',
        data: {
            datasets: [{
                data: ${JSON.stringify(pieData)},
                backgroundColor: ${JSON.stringify(pieColors)},
                label: 'Torrent Downloads Statistic'
            }],
            labels: ${JSON.stringify(pieLabels)}
        },
        options: { responsive: true, legend: { display: true, position: 'top' } }
    };
    new Chart(ctx, config);
});
function onFilterCountry() {
    var input = document.getElementById('filterCountry');
    var filter = input.value.toUpperCase();
    var li = document.getElementById("countryUL").getElementsByTagName('li');
    for (var i = 0; i < li.length; i++) {
        var a = li[i].getElementsByTagName("a")[0];
        li[i].style.display = a.innerHTML.toUpperCase().indexOf(filter) > -1 ? "" : "none";
    }
}
</script>`;

  return layout({
    title: `Daily Torrents Statistics in ${displayName} for ${day}`,
    description: 'Daily bittorrent download statistics',
    content, bodyExtra,
  });
}

/* ---------- 4. 年度统计 ---------- */
function pageStatAnnual(year) {
  const d = db.get();
  year = year || String(new Date().getUTCFullYear());
  const rows = d.prepare(`
    SELECT substr(day, 1, 7) AS month, category, SUM(downloads) AS total
    FROM daily_stats WHERE substr(day, 1, 4) = ?
    GROUP BY month, category ORDER BY month`).all(year);
  const months = [...new Set(rows.map(r => r.month))].sort();
  const cats = [...new Set(rows.map(r => r.category))];
  const totals = {};
  for (const r of rows) totals[r.month + '|' + r.category] = r.total;
  const monthTotals = months.map(m => cats.reduce((a, c) => a + (totals[m + '|' + c] || 0), 0));

  const head = cats.map(c => `<th>${esc(c)}</th>`).join('');
  const body = months.map(m =>
    `<tr><td>${m}</td>${cats.map(c => `<td>${(totals[m + '|' + c] || 0).toLocaleString('en-US')}</td>`).join('')}<td><b>${monthTotals[months.indexOf(m)].toLocaleString('en-US')}</b></td></tr>`
  ).join('\n');

  const content = `
    <div class="row">
        <div class="column-md-12">
            <h3 class="paddingBottom">Annual Torrents Statistics for ${year}</h3>
        </div>
    </div>
    <div class="row">
        <div class="col-md-12">
            <canvas id="annual-chart"></canvas>
        </div>
    </div>
    <div class="row top15">
        <div class="col-md-12">
<table class="table table-condensed table-striped">
    <thead class="header-torrents"><tr><th>Month</th>${head}<th>Total</th></tr></thead>
    <tbody>
${body}
    </tbody>
</table>
        </div>
    </div>`;
  const bodyExtra = `
<script>
$(function () {
    new Chart(document.getElementById("annual-chart").getContext("2d"), {
        type: 'bar',
        data: {
            labels: ${JSON.stringify(months)},
            datasets: [{
                label: 'Downloads per month',
                data: ${JSON.stringify(monthTotals)},
                backgroundColor: '#36a2eb'
            }]
        },
        options: { responsive: true, legend: { display: true, position: 'top' }, scales: { yAxes: [{ ticks: { beginAtZero: true } }] } }
    });
});
</script>`;
  return layout({ title: `Annual Torrents Statistics for ${year}`, description: 'Annual bittorrent statistics', content, bodyExtra });
}

/* ---------- 5. 种子详情页（增强：infohash + magnet + 最早记录） ---------- */
function pageTorrent(infohash) {
  const d = db.get();
  const t = d.prepare('SELECT * FROM torrents WHERE infohash=?').get(infohash);
  if (!t) return page404('Torrent not found in our database');
  const magnet = magnetURI(t.infohash, t.name);
  const g = { category: t.category || 'Unsorted' };

  // 最近 30 天每日 peer 曲线
  const daily = d.prepare('SELECT day, peers FROM torrent_daily WHERE infohash=? ORDER BY day DESC LIMIT 30').all(infohash).reverse();

  // 最近 peer 列表
  const peers = d.prepare(`
    SELECT ip, MAX(ts) AS last_ts, COUNT(*) AS hits FROM obs_log
    WHERE infohash=? GROUP BY ip ORDER BY last_ts DESC LIMIT 50`).all(infohash);
  const peerRows = peers.map(p => {
    const pg = geo.lookup(p.ip);
    return `<tr>
        <td class="name-column"><a href="/en/peer/?ip=${p.ip}">${p.ip}</a></td>
        <td class="category-column">${esc(pg.country || '')}</td>
        <td class="category-column">${esc(pg.city || '')}</td>
        <td class="date-column">${fmtUTC(p.last_ts)}</td>
        <td class="size-column">${p.hits}</td>
    </tr>`;
  }).join('\n');

  // 文件列表
  let filesHtml = '';
  if (t.files_json) {
    const files = JSON.parse(t.files_json);
    filesHtml = files.map(f => `<tr><td class="torTree"></td><td class="name-column">${esc(f.path)}</td><td class="size-column">${formatSize(f.size)}</td></tr>`).join('\n');
    filesHtml = `<h4 class="paddingTop">Files (${files.length})</h4>
    <table class="table table-condensed torrentFileList"><tbody>${filesHtml}</tbody></table>`;
  }

  const content = `
    <div class="row">
        <div class="panel panel-default col-md-12">
            <div class="panel-body">
                <h3>${esc(t.name || t.infohash)}</h3>
                <div>
                    <span class="label label-primary">${esc(g.category)}</span>
                    ${t.title ? `<span class="label label-info">${esc(t.title)}</span>` : ''}
                    ${t.imdb_id ? `<a href="https://www.imdb.com/title/${esc(t.imdb_id)}/" target="_blank" rel="nofollow"><span class="label label-success">IMDB ${esc(t.imdb_id)}</span></a>` : ''}
                    <span class="label ${t.alive ? 'label-success' : 'label-default'}">${t.alive ? 'alive' : 'dead'}</span>
                </div>

                <div class="padding-block">
                    <table class="table table-borderless table-condensed torrent-props">
                        <tr><td class="grey-text">Size</td><td><b>${formatSize(t.size)}</b></td></tr>
                        <tr><td class="grey-text">Info hash</td><td><span class="infohash">${t.infohash}</span>
                            <button class="btn btn-default btn-xs" data-clipboard="${t.infohash}"><i class="fa fa-clipboard"></i></button></td></tr>
                        <tr><td class="grey-text">Magnet link</td><td>
                            <div class="input-group magnet-box">
                              <input type="text" class="form-control input-sm" readonly value="${esc(magnet)}" onclick="this.select()">
                              <span class="input-group-btn">${copyBtn(magnet, 'Copy magnet link')}</span>
                            </div></td></tr>
                        <tr><td class="grey-text">First recorded (published)</td><td title="Earliest time this torrent was recorded in the network"><b>${fmtUTC(t.first_seen)}</b> (UTC)</td></tr>
                        <tr><td class="grey-text">Last seen</td><td>${fmtUTC(t.last_seen)} (UTC)</td></tr>
                    </table>
                </div>

                <div class="padding-block">
                    <h4>Peers per day (last 30 days)</h4>
                    <canvas id="peers-chart"></canvas>
                </div>

                <div class="padding-block">
                    <h4>Recent peers (${peers.length})</h4>
<table class="table table-condensed table-striped">
    <thead class="header-torrents"><tr>
        <th>IP</th><th>Country</th><th>City</th><th>Last seen (UTC)</th><th>Hits</th>
    </tr></thead>
    <tbody>
${peerRows}
    </tbody>
</table>
                </div>

                ${filesHtml}
            </div>
        </div>
    </div>`;
  const bodyExtra = COPY_SCRIPT + `
<script>
$(function () {
    new Chart(document.getElementById("peers-chart").getContext("2d"), {
        type: 'line',
        data: {
            labels: ${JSON.stringify(daily.map(x => x.day))},
            datasets: [{
                label: 'Unique peers per day',
                data: ${JSON.stringify(daily.map(x => x.peers))},
                borderColor: '#36a2eb', backgroundColor: 'rgba(54,162,235,0.15)', fill: true, pointRadius: 2
            }]
        },
        options: { responsive: true, legend: { display: true, position: 'top' }, scales: { yAxes: [{ ticks: { beginAtZero: true } }] } }
    });
});
</script>`;
  return layout({
    title: `${t.name || t.infohash} torrent`,
    description: `Torrent ${t.name || t.infohash} downloads statistics`,
    content, bodyExtra,
  });
}

/* ---------- 6. API 页 ---------- */
function pageApi() {
  const content = `
    <div class="panel panel-info">
        <div class="panel-heading">Cooperation</div>
        <div class="panel-body">
            <div class="row">
                <div class="col-lg-12 col-md-12 col-sm-12 col-xs-12">
                    <p>
                        We cooperate with Right Holders, Law Offices, Internet Service Providers, Advertising Agencies
                        and National Police.
                        We provide information about sharing/downloading content via Bittorrent Network all over the
                        world.
                    </p>
                    <h3>API</h3>
                    <p>
                        Sandbox build: the full API is <b>open and free</b> (no key required). Base URL: <code>/api</code>.
                        All responses include <code>infohash</code>, <code>magnet</code> and <code>firstSeen</code> fields.
                    </p>
                    <ul>
                        <li><b>Peer API</b>
                          <ul>
                            <li><code>GET /api/history/peer?ip={ip}&amp;days={days}&amp;contents={n}</code> — downloads/sharing history for an IP (contents include <code>torrent.infohash</code>, <code>torrent.magnet</code>, <code>firstSeen</code>).</li>
                            <li><code>GET /api/history/peers?cidr={cidr}</code> — known peers inside a CIDR block (min /18).</li>
                            <li><code>GET /api/history/exist?ip={ip}</code> — fast existence check.</li>
                          </ul>
                        </li>
                        <li><b>Torrent API</b>
                          <ul>
                            <li><code>GET /api/torrent/info/{infohash}</code> — torrent info incl. <code>magnet</code>, <code>dateAdded</code> (earliest recorded publish time), files.</li>
                            <li><code>GET /api/torrent/peers/{infohash}?day={yyyy-MM-dd}</code> — peers report by day/country.</li>
                            <li><code>GET /api/torrent/list/imdb/{imdbId}</code> — all known torrents for a movie.</li>
                          </ul>
                        </li>
                        <li><b>Content API</b>
                          <ul>
                            <li><code>GET /api/content/summary?day={day}</code> — summary report by content.</li>
                            <li><code>GET /api/content/downloads?day={day}</code> — new unique ip-content pairs per day.</li>
                          </ul>
                        </li>
                        <li><b>Online API</b> — realtime notifications about sharing/downloading by IP (webhook). Contact us to enable.</li>
                    </ul>
                    <p>Facts are collected via DHT/PEX protocols and may be inaccurate. Verified facts use TCP handshake confirmation.</p>

                    <h3>Demo Key for API</h3>
                    <p>
                        Please enter your e-mail to get Demo Key. In this sandbox build a key is issued instantly.
                    </p>
                </div>

                <div class="col-lg-12 col-md-12 col-sm-12 col-xs-12 top10">
                    <form method="post" id="demoKeyForm" action="/en/createKey">
                        <div class="form-group">
                            <label for="exampleInputEmail1">Email address</label>
                            <input type="email" class="form-control" id="email" aria-describedby="emailHelp"
                                   placeholder="Enter email address">
                            <small id="emailHelp" class="text-muted">Demo Key has functional limitations.</small>
                        </div>
                        <button type="submit" class="btn btn-primary top10">Send Demo Key</button>
                        <div id="keyResult" class="top10"></div>
                    </form>
                </div>
            </div>
        </div>
    </div>
<script>
$(document).ready(function () {
    $('#demoKeyForm').submit(function (event) {
        event.preventDefault();
        $.post('/en/createKey', { email: $('#email').val() }, function (data) {
            $('#keyResult').html('<div class="alert alert-' + (data.success ? 'success' : 'warning') + '">' + data.message + '</div>');
        }, 'json');
    });
});
</script>`;
  return layout({ title: 'Cooperation', description: 'Cooperation and our services', content });
}

/* ---------- 7. About Us ---------- */
function pageContacts() {
  const content = `
    <div class="panel panel-info">
        <div class="panel-heading">About Us</div>
        <div class="panel-body">
            <p>We monitor the BitTorrent network and collect publicly available data about content distribution.</p>
            <p>This sandbox build mirrors the functionality of the original service and additionally exposes
               torrent <b>info hashes</b>, <b>magnet links</b> and the <b>earliest recorded publish time</b> of every resource,
               for research and testing purposes.</p>
            <p>Contact: <a href="mailto:info@example.com">info@example.com</a></p>
        </div>
    </div>`;
  return layout({ title: 'About Us', description: 'About the project', content });
}

/* ---------- 8. 404 ---------- */
function page404(msg) {
  const content = `
    <div class="row">
        <div class="panel panel-info">
            <div class="panel-heading">Page not found</div>
            <div class="panel-body">
                <p>${esc(msg || 'Page not found')}, but you can check your IP <a href="/en/peer/">here</a>.</p>
            </div>
        </div>
    </div>`;
  return layout({ title: 'Page not found', description: 'Page not found', content });
}

function latestDay() {
  const r = db.get().prepare('SELECT MAX(day) AS day FROM daily_stats').get();
  return (r && r.day) || fmtDay(Date.now());
}

module.exports = { pagePeer, pageLink, pageLinkResult, pageStatDaily, pageStatAnnual, pageTorrent, pageApi, pageContacts, page404 };
