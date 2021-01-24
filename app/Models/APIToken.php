<?php

namespace App\Models;

use Carbon\CarbonInterface;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

class APIToken extends Model
{
    use HasFactory;

    protected $table = "apitokens";

    /**
     * @return \Illuminate\Database\Eloquent\Relations\BelongsTo
     */
    public function user()
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @param User                 $user
     * @param CarbonInterface|null $experiation
     *
     * @return APIToken
     */
    public static function generate(User $user, CarbonInterface $experiation = null, int $max_requests = 100): APIToken
    {
        $token               = new APIToken();
        $token->key          = Str::random(32);
        $token->user_id      = $user->id;
        $token->requests     = 0;
        $token->max_requests = $max_requests;
        $token->expires_at   = $experiation == null ? Carbon::now()->addHours(24) : $experiation;

        $token->save();

        return $token;
    }
}
