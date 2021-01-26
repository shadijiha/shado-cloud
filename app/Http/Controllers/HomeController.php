<?php

namespace App\Http\Controllers;

use App\Models\APIToken;
use Carbon\Carbon;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Support\Renderable;
use Illuminate\Contracts\View\Factory;
use Illuminate\Contracts\View\View;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

class HomeController extends Controller
{
    /**
     * Create a new controller instance.
     *
     * @return void
     */
    public function __construct()
    {
        $this->middleware('auth');
    }

    /**
     * Show the application dashboard.
     *
     * @param Request               $request
     * @param FileFetcherController $controller
     *
     * @return Renderable|void
     */
    public function index(Request $request, FileFetcherController $controller)
    {
        // See if it is a file or not (to preview)
        $path = $request->get("path");
        if (File::isDirectory($path) || $path == "" || $path == null) {

            $data = $controller->indexDirectories($path);
            return view('home')->with(
                [
                    "files" => $data,
                    "path"  => $path ?? env("CLOUD_FILES_PATH")
                ]);

        } else {
            if (File::exists($path))
                return view('preview')->with([
                    "file" => new FileStruct(new \SplFileInfo($path)),
                    "path" => null
                ]);
            else
                return abort(404);
        }
    }

    /**
     * @param Request $request
     *
     * @return Application|Factory|View
     */
    public function settings(Request $request)
    {
        return view('settings')->with(
            ['tokens' => Auth::user()->apiTokens]);
    }

    /**
     * Generates an API token and adds it to the database
     *
     * @param Request $request
     *
     * @return RedirectResponse
     */
    public function generate(Request $request)
    {
        $token           = new APIToken();
        $token->user_id  = Auth::user()->id;
        $token->readonly = $request->get("readonly") ?? true;

        $token->expires_at = $request->get("expiration") == null ?
            Carbon::now()->addHours(24) : Carbon::parse($request->get("expiration"));

        $token->requests     = 0;
        $token->max_requests = $request->get("max_requests") ?? 100;
        $token->key          = Str::random(32);
        $token->save();

        return redirect()->back()->with(['tokens' => Auth::user()->apiTokens]);
    }

    /**
     * @param Request $request
     *
     * @return RedirectResponse
     */
    public function deleteAPIKey(Request $request)
    {
        $id = $request->get("id");
        APIToken::find($id)->delete();
        return redirect()->back()->with(['tokens' => Auth::user()->apiTokens]);
    }

}
