//! Native share-sheet hand-off for the bundle payload. macOS opens the AirDrop
//! panel directly via AppKit `NSSharingService`; iOS presents the system share
//! sheet (AirDrop among the options) via UIKit `UIActivityViewController`. Other
//! platforms return an error — the UI hides the affordance via the
//! `airdrop_available` runtime capability, so this is a belt-and-braces guard.

/// Present the native share sheet for the given file paths (a finished
/// `.nvbundle` directory). Apple platforms only.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn share_via_airdrop(app: &tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("share: nothing to share".to_string());
    }

    // The share UI must run on the main (AppKit/UIKit) thread. Hop there, run the
    // call, and send the result back over a channel.
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(present_share_sheet(&paths));
    })
    .map_err(|error| format!("share: dispatch to main thread: {error}"))?;

    rx.recv()
        .map_err(|error| format!("share: main-thread result dropped: {error}"))?
}

/// Build an `NSArray` of file `NSURL`s, upcast to `AnyObject` so it matches the
/// untyped `NSArray` parameter both platforms' share APIs take.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn file_url_array(paths: &[String]) -> objc2::rc::Retained<objc2_foundation::NSArray> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSArray, NSString, NSURL};

    let mut items: Vec<Retained<AnyObject>> = Vec::with_capacity(paths.len());
    for path in paths {
        let ns_path = NSString::from_str(path);
        let url = NSURL::fileURLWithPath(&ns_path);
        items.push(url.into_super().into_super());
    }
    NSArray::from_retained_slice(&items)
}

#[cfg(target_os = "macos")]
fn present_share_sheet(paths: &[String]) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSSharingService, NSSharingServiceNameSendViaAirDrop};

    MainThreadMarker::new().ok_or("share: not on the main thread")?;
    let array = file_url_array(paths);

    // SAFETY: the AirDrop service name is a framework constant; `performWithItems:`
    // is a standard AppKit call and we are on the main thread with a valid array.
    let service = NSSharingService::sharingServiceNamed(unsafe { NSSharingServiceNameSendViaAirDrop })
        .ok_or("share: AirDrop service is unavailable")?;
    unsafe { service.performWithItems(&array) };
    Ok(())
}

#[cfg(target_os = "ios")]
#[allow(deprecated)] // UIApplication::keyWindow is deprecated but works for a single-window app.
fn present_share_sheet(paths: &[String]) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_ui_kit::{UIActivityViewController, UIApplication};

    let mtm = MainThreadMarker::new().ok_or("share: not on the main thread")?;
    let array = file_url_array(paths);

    let app = UIApplication::sharedApplication(mtm);
    let window = app
        .keyWindow()
        .or_else(|| app.windows().firstObject())
        .ok_or("share: no window to present from")?;
    let root = window
        .rootViewController()
        .ok_or("share: no root view controller")?;

    // SAFETY: standard UIKit call; `array` holds NSURLs which are valid activity
    // items, and we are on the main thread.
    let sheet = unsafe {
        UIActivityViewController::initWithActivityItems_applicationActivities(mtm.alloc(), &array, None)
    };

    // On iPad the sheet is a popover and needs a source anchor or it aborts;
    // anchoring to the root view (default rect) is enough. iPhone ignores this.
    if let (Some(popover), Some(view)) = (sheet.popoverPresentationController(), root.view()) {
        popover.setSourceView(Some(&view));
    }

    root.presentViewController_animated_completion(&sheet, true, None);
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn share_via_airdrop(_app: &tauri::AppHandle, _paths: Vec<String>) -> Result<(), String> {
    Err("Native sharing is only available on Apple platforms".to_string())
}
