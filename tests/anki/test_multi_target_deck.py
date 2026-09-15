import re
import os
import pytest
from anki.errors import NotFoundError  # noqa
from anki.collection import Collection
from anki.collection import SearchNode
# from conftest import col

test_name = os.path.basename(__file__)[5:-3]
col_path = 'tests/test_outputs/{}/Anki2/User 1/collection.anki2'.format(test_name)
test_file_paths = [
    ['tests/test_outputs/{}/Obsidian/{}/{}.md'.format(test_name, test_name, test_name), 'DeckOne'],
    ['tests/test_outputs/{}/Obsidian/{}/{}.md'.format(test_name, test_name, test_name), 'DeckTwo'],
    ['tests/test_outputs/{}/Obsidian/{}/{}.locked.md'.format(test_name, test_name, test_name), 'LockedDeck'],
]

@pytest.fixture(scope="module")
def col():
    col = Collection(col_path)
    yield col
    col.close()

def test_col_exists(col):
    assert not col.is_empty()

def test_deck_default_exists(col: Collection):
    assert col.decks.id_for_name('DeckOne') is not None
    assert col.decks.id_for_name('DeckTwo') is not None
    assert col.decks.id_for_name('LockedDeck') is not None
    # This deck should NOT exist - it was in a body TARGET DECK line
    # but the frontmatter locked the file to LockedDeck
    with pytest.raises(NotFoundError):
        col.decks.id_for_name('IgnoredDeck')

def test_cards_count(col: Collection):
    # multi_target_deck.md: 2 cards, one in DeckOne, one in DeckTwo
    assert len(col.find_cards( col.build_search_string(SearchNode(deck='DeckOne')) )) == 1
    assert len(col.find_cards( col.build_search_string(SearchNode(deck='DeckTwo')) )) == 1
    # multi_target_deck.locked.md: 1 card, in LockedDeck (frontmatter lock)
    assert len(col.find_cards( col.build_search_string(SearchNode(deck='LockedDeck')) )) == 1

def test_cards_ids_from_obsidian(col: Collection):

    ID_REGEXP_STR = r'\n?(?:<!--)?(?:ID: (\d+).*)'

    for obsidian_test_md, deck_name in test_file_paths:
        obs_IDs = []
        with open(obsidian_test_md) as file:
            for line in file:            
                output = re.search(ID_REGEXP_STR, line.rstrip())
                if output is not None:
                    output = output.group(1)
                    obs_IDs.append(output)

        anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck=deck_name)) )
        for aid, oid in zip(anki_IDs, obs_IDs):
            assert str(aid) == oid
