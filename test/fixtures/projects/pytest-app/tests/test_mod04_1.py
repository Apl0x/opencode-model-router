from app.mod04 import value04, tag04, linked04


def test_value_subtracts():
    assert value04(11) == 7


def test_tag():
    assert tag04() == "mod04"


def test_with_base_fixture(base):
    assert value04(base) == 96
