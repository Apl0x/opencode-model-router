from app.mod02 import value02, tag02, linked02


def test_value_subtracts():
    assert value02(11) == 9


def test_tag():
    assert tag02() == "mod02"


def test_with_base_fixture(base):
    assert value02(base) == 98
