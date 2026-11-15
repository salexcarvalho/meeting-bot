from datetime import datetime, timedelta, timezone

from host_agent.alerts import AlertScheduler, Meeting

T0 = datetime(2026, 9, 17, 13, 0, tzinfo=timezone.utc)


def meeting(**kw):
    base = dict(
        id="m1",
        title="Portal SES",
        start=T0,
        end=T0 + timedelta(hours=1),
        url="https://teams.microsoft.com/l/meetup-join/x",
        skip_recording=False,
        status="scheduled",
    )
    base.update(kw)
    return Meeting(**base)


def test_fires_at_15_5_1_minutes(tmp_path):
    s = AlertScheduler(tmp_path / "alerts.json", minutes_before=[15, 5, 1])
    m = [meeting()]
    assert s.due(T0 - timedelta(minutes=16), m) == []
    fired = s.due(T0 - timedelta(minutes=15), m)
    assert [(a.meeting.id, a.minutes) for a in fired] == [("m1", 15)]
    s.mark(fired[0])
    assert s.due(T0 - timedelta(minutes=14), m) == []
    fired = s.due(T0 - timedelta(minutes=5), m)
    assert [a.minutes for a in fired] == [5]
    s.mark(fired[0])
    fired = s.due(T0 - timedelta(seconds=60), m)
    assert [a.minutes for a in fired] == [1]
    assert fired[0].final is True


def test_late_alert_is_skipped(tmp_path):
    s = AlertScheduler(tmp_path / "alerts.json", minutes_before=[15, 5, 1])
    m = [meeting()]
    # Computador acordou 3 min antes: só o alerta de 1 min ainda vale, os anteriores são descartados.
    now = T0 - timedelta(minutes=3)
    assert s.due(now, m) == []
    assert s.due(T0 - timedelta(minutes=1), m)[0].minutes == 1


def test_only_most_recent_pending_alert_fires(tmp_path):
    s = AlertScheduler(tmp_path / "alerts.json", minutes_before=[15, 5, 1])
    # 30 s de atraso no de 5 min ainda dispara (tolerância de 60 s).
    fired = s.due(T0 - timedelta(minutes=4, seconds=30), [meeting()])
    assert [a.minutes for a in fired] == [5]


def test_dedup_survives_restart(tmp_path):
    path = tmp_path / "alerts.json"
    s = AlertScheduler(path, minutes_before=[15, 5, 1])
    fired = s.due(T0 - timedelta(minutes=15), [meeting()])
    s.mark(fired[0])
    s2 = AlertScheduler(path, minutes_before=[15, 5, 1])
    assert s2.due(T0 - timedelta(minutes=15), [meeting()]) == []


def test_reschedule_creates_new_key(tmp_path):
    s = AlertScheduler(tmp_path / "alerts.json", minutes_before=[15, 5, 1])
    fired = s.due(T0 - timedelta(minutes=15), [meeting()])
    s.mark(fired[0])
    later = meeting(start=T0 + timedelta(minutes=30), end=T0 + timedelta(minutes=90))
    fired = s.due(T0 + timedelta(minutes=15), [later])
    assert [a.minutes for a in fired] == [15]


def test_skipped_meeting_only_offers_join(tmp_path):
    s = AlertScheduler(tmp_path / "alerts.json", minutes_before=[15, 5, 1])
    fired = s.due(T0 - timedelta(minutes=5), [meeting(skip_recording=True, status="skipped")])
    assert fired[0].offer_skip is False
    assert fired[0].offer_join is True


def test_no_link_means_no_join(tmp_path):
    s = AlertScheduler(tmp_path / "alerts.json", minutes_before=[15, 5, 1])
    fired = s.due(T0 - timedelta(minutes=5), [meeting(url=None)])
    assert fired[0].offer_join is False
    assert fired[0].offer_skip is True


def test_recording_meeting_gets_no_alert(tmp_path):
    s = AlertScheduler(tmp_path / "alerts.json", minutes_before=[15, 5, 1])
    assert s.due(T0 - timedelta(minutes=1), [meeting(status="recording")]) == []


def test_prunes_old_entries(tmp_path):
    path = tmp_path / "alerts.json"
    s = AlertScheduler(path, minutes_before=[15])
    s.mark(s.due(T0 - timedelta(minutes=15), [meeting()])[0])
    s.prune(T0 + timedelta(days=3))
    assert s.fired == {}


def _api(**kw):
    base = {
        "id": "m-sabado",
        "title": "Reunião de sábado",
        "start": "2026-11-14T13:00:00Z",
        "end": "2026-11-14T14:00:00Z",
        "url": None,
        "status": "scheduled",
    }
    base.update(kw)
    return base


def test_off_day_meeting_without_user_request_gets_no_alert(tmp_path):
    # Fim de semana (WORKING_DAYS no backend): o backend marca noAlerts e o host-agent não avisa.
    s = AlertScheduler(tmp_path / "alerts.json", minutes_before=[15, 5, 1])
    quiet = Meeting.from_api(_api(noAlerts=True))
    assert quiet.no_alerts is True
    assert s.due(quiet.start - timedelta(minutes=15), [quiet]) == []
    assert s.due(quiet.start - timedelta(minutes=1), [quiet]) == []


def test_off_day_meeting_with_user_request_alerts_normally(tmp_path):
    s = AlertScheduler(tmp_path / "alerts.json", minutes_before=[15, 5, 1])
    wanted = Meeting.from_api(_api(noAlerts=False))
    assert [a.minutes for a in s.due(wanted.start - timedelta(minutes=15), [wanted])] == [15]


def test_missing_no_alerts_field_keeps_alerting(tmp_path):
    # Cache antigo ou backend anterior: sem o campo, o comportamento não muda.
    s = AlertScheduler(tmp_path / "alerts.json", minutes_before=[15, 5, 1])
    old = Meeting.from_api(_api())
    assert old.no_alerts is False
    assert s.due(old.start - timedelta(minutes=15), [old])
