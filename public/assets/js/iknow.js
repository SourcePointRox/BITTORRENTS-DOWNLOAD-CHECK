/* 站点辅助脚本（对齐官网 iknow.js 行为） */
function getTimeRemaining(endtime) {
    var t = Date.parse(endtime) - Date.parse(new Date());
    var seconds = Math.floor((t / 1000) % 60);
    var minutes = Math.floor((t / 1000 / 60) % 60);
    var hours = Math.floor((t / (1000 * 60 * 60)) % 24);
    var days = Math.floor(t / (1000 * 60 * 60 * 24));
    return { 'total': t, 'days': days, 'hours': hours, 'minutes': minutes, 'seconds': seconds };
}

function initializeClock(id, endtime) {
    var clock = document.getElementById(id);
    if (!clock) return;
    var hoursSpan = clock.querySelector('.hours');
    var minutesSpan = clock.querySelector('.minutes');
    var secondsSpan = clock.querySelector('.seconds');

    function updateClock() {
        var t = getTimeRemaining(endtime);
        if (hoursSpan) hoursSpan.innerHTML = ('0' + t.hours).slice(-2);
        if (minutesSpan) minutesSpan.innerHTML = ('0' + t.minutes).slice(-2);
        if (secondsSpan) secondsSpan.innerHTML = ('0' + t.seconds).slice(-2);
        if (t.total <= 0) clearInterval(timeinterval);
    }
    updateClock();
    var timeinterval = setInterval(updateClock, 1000);
}

function checkVisited(token) {
    function check() {
        fetch('/link/check/' + token)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.visited) {
                    location.reload();
                    clearInterval(timeinterval);
                }
            })
            .catch(function () {});
    }
    check();
    var timeinterval = setInterval(check, 30000);
}
