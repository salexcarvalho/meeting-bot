from worker_gpu.asr import SegmentOut, Word
from worker_gpu.diarize import Diarizer, Turn, assign_speakers


def test_segment_without_words_takes_speaker_with_most_overlap():
    segs = [SegmentOut(0.0, 4.0, "a"), SegmentOut(4.0, 6.0, "b")]
    turns = [Turn(0.0, 1.0, "SPK_B"), Turn(1.0, 4.0, "SPK_A"), Turn(4.0, 6.0, "SPK_B")]
    out = assign_speakers(segs, turns)
    # SPK_A fala primeiro no resultado → Speaker 1
    assert [(s.text, s.speaker) for s in out] == [("a", "Speaker 1"), ("b", "Speaker 2")]


def test_words_split_segment_on_speaker_change():
    words = [Word(0.0, 0.5, " vamos"), Word(0.5, 1.0, " usar"), Word(1.2, 1.6, " Kafka?"), Word(1.7, 2.0, " Sim.")]
    segs = [SegmentOut(0.0, 2.0, "vamos usar Kafka? Sim.", None, words)]
    turns = [Turn(0.0, 1.65, "X"), Turn(1.65, 2.1, "Y")]
    out = assign_speakers(segs, turns)
    assert [(s.text, s.speaker, s.start, s.end) for s in out] == [
        ("vamos usar Kafka?", "Speaker 1", 0.0, 1.6),
        ("Sim.", "Speaker 2", 1.7, 2.0),
    ]


def test_word_between_turns_uses_nearest_within_one_second():
    words = [Word(0.0, 0.4, " oi"), Word(3.0, 3.2, " tudo")]
    segs = [SegmentOut(0.0, 3.2, "oi tudo", None, words)]
    turns = [Turn(0.0, 0.5, "X"), Turn(3.9, 5.0, "Y")]
    out = assign_speakers(segs, turns)
    assert [(s.text, s.speaker) for s in out] == [("oi", "Speaker 1"), ("tudo", "Speaker 2")]


def test_no_turns_keeps_segments():
    segs = [SegmentOut(0.0, 1.0, "a")]
    assert assign_speakers(segs, []) == segs


def test_unavailable_without_token(tmp_path):
    d = Diarizer(token=None, hf_home=str(tmp_path), device="cpu")
    assert d.status()[0] == "unavailable"
    assert not d.available()


def test_available_with_token_or_cache(tmp_path):
    assert Diarizer(token="hf_x", hf_home=str(tmp_path), device="cpu").available()
    snap = tmp_path / "hub" / "models--pyannote--speaker-diarization-community-1" / "snapshots" / "abc"
    snap.mkdir(parents=True)
    assert Diarizer(token=None, hf_home=str(tmp_path), device="cpu").available()
