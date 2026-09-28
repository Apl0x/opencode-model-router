from app.mod10 import value10, tag10, linked10


def test_value_subtracts():
    assert value10(11) == 1


def test_tag():
    assert tag10() == "mod10"


def test_with_base_fixture(base):
    assert value10(base) == 90
