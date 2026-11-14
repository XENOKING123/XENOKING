//! End-to-end checks on real game-written saves. Run only when
//! `XENO_SAVE_VECTORS` points at the directory holding them (the files are not
//! in the repository); otherwise each test prints a note and passes.
#![cfg(test)]

use crate::container;
use crate::convert::{
    collect_slot_identities, convert, merge_pc_to_ps5, steam_id_from_photo, Direction,
};
use crate::games;
use crate::mandarin::{self, MandarinKey};
use crate::stream::{rebase_with, StringField};
use std::path::PathBuf;

fn vectors() -> Option<PathBuf> {
    match std::env::var_os("XENO_SAVE_VECTORS") {
        Some(dir) => Some(PathBuf::from(dir)),
        None => {
            eprintln!("skipping real-file test: set XENO_SAVE_VECTORS");
            None
        }
    }
}

fn wilds() -> &'static games::Game {
    games::by_id("monster-hunter-wilds").unwrap()
}

/// The object stream a file holds, normalised to base 16 so two platforms'
/// files can be compared.
fn stream16(file: &[u8], key: Option<&MandarinKey>) -> Vec<u8> {
    let d = container::decode(file, key).expect("decode");
    rebase_with(&d.stream, d.stream_base, 16, &mut |_: &StringField<'_>| {
        None
    })
    .expect("rebase")
}

fn wilds_key(id: u64) -> MandarinKey {
    MandarinKey {
        enc_seed: wilds().enc_seed,
        rsa_seed: wilds().rsa_seed,
        key64: !id,
    }
}

#[test]
fn ps5_system_data_round_trips_through_pc() {
    let Some(root) = vectors() else { return };
    let ps5 = std::fs::read(root.join("samples/ps5/data00-1.bin")).unwrap();
    let target = 76_561_198_012_345_678u64;

    let pc = convert(wilds(), Direction::Ps5ToPc, target, &ps5).unwrap();
    assert_eq!(container::peek_flags(&pc.data).unwrap(), 0x18);
    assert_eq!(
        stream16(&pc.data, Some(&wilds_key(target))),
        stream16(&ps5, None)
    );
    assert_eq!(pc.identity_reset, 0, "system data has no identity fields");

    let back = convert(wilds(), Direction::PcToPs5, target, &pc.data).unwrap();
    assert_eq!(container::peek_flags(&back.data).unwrap(), 0x08);
    assert_eq!(stream16(&back.data, None), stream16(&ps5, None));
}

#[test]
fn pc_character_data_converts_and_resets_identity() {
    let Some(root) = vectors() else { return };
    let pc = std::fs::read(root.join("samples/pc_wilds/2246340/remote/win64_save/data001Slot.bin"))
        .unwrap();

    // Recover the account from the file, the way the tool does.
    let (body, len) = container::encrypted_parts(&pc).unwrap();
    let id = mandarin::find_steam_id64(body, len, wilds().enc_seed).expect("account found");

    let ps5 = convert(wilds(), Direction::PcToPs5, id, &pc).unwrap();
    assert_eq!(container::peek_flags(&ps5.data).unwrap(), 0x08);
    assert!(
        ps5.identity_reset >= 2,
        "the active hunter's id should be reset"
    );

    // Data is unchanged apart from the identity reset.
    let fresh: Vec<u8> = "--------"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let hashes = [
        crate::stream::name_hash("HunterId"),
        crate::stream::name_hash("HunterShortId"),
    ];
    let want = {
        let d = container::decode(&pc, Some(&wilds_key(id))).unwrap();
        rebase_with(&d.stream, 16, 16, &mut |f: &StringField<'_>| {
            hashes.contains(&f.name_hash).then(|| fresh.clone())
        })
        .unwrap()
    };
    assert_eq!(stream16(&ps5.data, None), want);
}

#[test]
fn account_is_read_from_the_pc_photo_file() {
    let Some(root) = vectors() else { return };
    // The PC in-game-photo file (flags 0x02, HAS_ID) names the Steam account,
    // so the tool can offer the id without a search. This is the one that
    // matters: PC -> PS5 reads it; PS5 -> PC takes a target account instead.
    let pc_ss1 =
        std::fs::read(root.join("samples/pc_wilds/2246340/remote/win64_save/SS1_data001Slot.bin"))
            .unwrap();
    let from_photo = steam_id_from_photo(&pc_ss1).expect("PC photo names an account");
    // Cross-check: the id read from the photo must be the same account the
    // encrypted character save actually opens with (no hard-coded id).
    let char_save =
        std::fs::read(root.join("samples/pc_wilds/2246340/remote/win64_save/data001Slot.bin"))
            .unwrap();
    let (body, len) = container::encrypted_parts(&char_save).unwrap();
    let from_crypto = mandarin::find_steam_id64(body, len, wilds().enc_seed).unwrap();
    assert_eq!(from_photo, from_crypto);

    // The PS5 photo stores no account id (flags 0x00), which is fine — the PS5
    // side never needs the source account.
    let ps5_ss1 = std::fs::read(root.join("samples/ps5/SS1_data001Slot.bin")).unwrap();
    assert_eq!(steam_id_from_photo(&ps5_ss1), None);
}

#[test]
fn merge_grafts_the_reference_slot_identity_onto_pc_progress() {
    let Some(root) = vectors() else { return };
    let pc = std::fs::read(root.join("samples/pc_wilds/2246340/remote/win64_save/data001Slot.bin"))
        .unwrap();
    let (body, len) = container::encrypted_parts(&pc).unwrap();
    let id = mandarin::find_steam_id64(body, len, wilds().enc_seed).unwrap();

    // Use the PC save itself as the "genuine reference": its slot-0 hunter has
    // a real id (not "--------"), slots 1-2 are empty. The merge must carry
    // that slot-0 id onto the (PS5-format) output instead of wiping it, while
    // empty reference slots fall back to a reset.
    let merged = merge_pc_to_ps5(wilds(), id, &pc, &decode_ps5_ref(&pc, id)).unwrap();
    assert_eq!(container::peek_flags(&merged.data).unwrap(), 0x08);
    assert_eq!(
        merged.identity_reset, 1,
        "exactly one slot had a real id to graft"
    );

    // The output's slot-0 HunterId equals the PC original (grafted, not blank).
    let want = collect_slot_identities(
        &container::decode(&pc, Some(&wilds_key(id))).unwrap().stream,
        16,
    )
    .unwrap();
    let got = collect_slot_identities(&container::decode(&merged.data, None).unwrap().stream, 12)
        .unwrap();
    assert_eq!(got.hunter_ids[0], want.hunter_ids[0], "slot 0 id grafted");
    assert_ne!(
        got.hunter_ids[0],
        "--------"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<u8>>(),
        "slot 0 must not be the reset value"
    );
    // Empty reference slots stay reset.
    let blank: Vec<u8> = "--------"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    assert_eq!(got.hunter_ids[1], blank);
}

// Helper: the merge takes the reference as a *decrypted PS5* file. Make one
// from the PC save (same hunter) so the test has a reference without a real
// PS5 character file: convert PC->PS5 (which resets ids), then we can't reuse
// its ids — so instead decode the PC save, re-encode as PS5 keeping ids.
fn decode_ps5_ref(pc: &[u8], id: u64) -> Vec<u8> {
    let d = container::decode(pc, Some(&wilds_key(id))).unwrap();
    // Re-lay-out to PS5 base and encode, WITHOUT resetting identity, so the
    // reference keeps the original hunter ids (stands in for a genuine PS5 save).
    let ps5_stream = rebase_with(&d.stream, d.stream_base, 12, &mut |_: &StringField<'_>| {
        None
    })
    .unwrap();
    container::encode(&ps5_stream, container::FLAG_DEFLATE, None).unwrap()
}
