//! OS share-sheet hand-off. macOS uses AppKit's `NSSharingService` to open the
//! AirDrop panel directly for a set of file paths (a finished `.nvbundle`). This
//! is the desktop transport for the bundle payload; iOS will need its own
//! `UIActivityViewController` plugin later, so keep the entry point generic.

/// Present the AirDrop sheet for the given file paths. macOS only — other
/// platforms return an error (the UI hides the affordance via the runtime
/// capability flag, so this is a belt-and-braces guard).
#[cfg(target_os = "macos")]
pub fn share_via_airdrop(app: &tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("share_via_airdrop: nothing to share".to_string());
    }

    // `NSSharingService` shows UI, so it must run on the main (AppKit) thread.
    // Hop there, run the call, and send the result back over a channel.
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(airdrop_on_main_thread(&paths));
    })
    .map_err(|error| format!("share_via_airdrop: dispatch to main thread: {error}"))?;

    rx.recv()
        .map_err(|error| format!("share_via_airdrop: main-thread result dropped: {error}"))?
}

#[cfg(target_os = "macos")]
fn airdrop_on_main_thread(paths: &[String]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSSharingService, NSSharingServiceNameSendViaAirDrop};
    use objc2_foundation::{NSArray, NSString, NSURL};

    // Assert we really are on the main thread before touching AppKit.
    MainThreadMarker::new().ok_or("share_via_airdrop: not on the main thread")?;

    // Build an NSArray of file NSURLs (upcast to AnyObject so the array matches
    // `performWithItems:`'s untyped `NSArray` parameter).
    let mut items: Vec<Retained<AnyObject>> = Vec::with_capacity(paths.len());
    for path in paths {
        let ns_path = NSString::from_str(path);
        let url = NSURL::fileURLWithPath(&ns_path);
        items.push(url.into_super().into_super());
    }
    let array = NSArray::from_retained_slice(&items);

    // SAFETY: the AirDrop service name is a framework constant; `performWithItems:`
    // is a standard AppKit call and we are on the main thread with a valid array.
    let service = NSSharingService::sharingServiceNamed(unsafe { NSSharingServiceNameSendViaAirDrop })
        .ok_or("share_via_airdrop: AirDrop service is unavailable")?;
    unsafe { service.performWithItems(&array) };
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn share_via_airdrop(_app: &tauri::AppHandle, _paths: Vec<String>) -> Result<(), String> {
    Err("AirDrop sharing is only available on macOS".to_string())
}
