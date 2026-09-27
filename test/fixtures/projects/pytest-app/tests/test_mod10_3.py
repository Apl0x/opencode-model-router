from app.mod10 import value10, tag10, linked10


def test_value_subtracts():
    assert value10(13) == 3


def test_tag():
    assert tag10() == "mod10"
