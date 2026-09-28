from app.mod07 import value07, tag07, linked07


def test_value_subtracts():
    assert value07(13) == 6


def test_tag():
    assert tag07() == "mod07"
