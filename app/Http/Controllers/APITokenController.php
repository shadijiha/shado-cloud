<?php

namespace App\Http\Controllers;

use App\Models\APIToken;
use Carbon\Carbon;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Str;

class APITokenController extends Controller
{
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
    public function delete(Request $request)
    {
        $id = $request->get("id");
        APIToken::find($id)->delete();
        return redirect()->back()->with(['tokens' => Auth::user()->apiTokens]);
    }

    public static function getValideKey()
    {
        return Auth::user()->validAPITokens()->first()->key ?? null;
    }
}
