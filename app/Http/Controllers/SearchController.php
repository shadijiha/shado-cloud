<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;

class SearchController extends Controller
{
    /**
     * @param Request $request
     *
     * @return mixed
     */
    public function search(Request $request)
    {
        return $request->get("search");
    }
}
