from spoiler.labels import DELETE_LABELS, Label, is_deleted


def test_all_non_benign_levels_are_deleted():
    assert DELETE_LABELS == {Label.DIRECT, Label.STRONG_HINT, Label.WEAK_HINT}
    assert is_deleted(Label.WEAK_HINT)
    assert not is_deleted(Label.BENIGN)


def test_labels_match_policy_values():
    assert [label.value for label in Label] == ["direct", "strong_hint", "weak_hint", "benign"]
