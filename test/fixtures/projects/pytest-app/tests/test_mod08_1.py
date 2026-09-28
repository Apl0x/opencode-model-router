from app.mod08 import value08, tag08, linked08


def test_value_subtracts():
    assert value08(11) == 3


def test_tag():
    assert tag08() == "mod08"


def test_with_base_fixture(base):
    assert value08(base) == 92
