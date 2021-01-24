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

    protected $table = "APITokens";

    /**
     * @return \Illuminate\Database\Eloquent\Relations\BelongsTo
     */
    public function user()
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @return bool
     */
    public function isValid(): bool
    {
        return !Carbon::parse($this->expires_at)->lessThan(Carbon::now()) && $this->requests < $this->max_requests;
    }


    /**
     * @param APITokenBuilder $builder
     *
     * @return APIToken
     */
    public static function generate(APITokenBuilder $builder): APIToken
    {
        $token = $builder->build();
        $token->save();
        return $token;
    }
}

/**
 * Builder class
 */
class APITokenBuilder
{
    public $key;
    public $user_id = -1;
    public $requests = 0;
    public $max_requests = 100;
    public $expires_at;
    public $readonly;

    public function __construct(User $user)
    {
        $this->user_id    = $user->id;
        $this->expires_at = Carbon::now()->addHours(24);
        $this->readonly   = true;
        $this->key        = Str::random(32);
    }

    /**
     * @param CarbonInterface $date
     *
     * @return $this
     */
    public function expiresAt(CarbonInterface $date): APITokenBuilder
    {
        $this->expires_at = $date;
        return $this;
    }

    /**
     * @param int $value
     *
     * @return $this
     */
    public function maxRequests(int $value): APITokenBuilder
    {
        $this->max_requests = $value;
        return $this;
    }

    /**
     * @param bool $value
     *
     * @return $this
     */
    public function readonly(bool $value): APITokenBuilder
    {
        $this->readonly = $value;
        return $this;
    }

    public function build(): APIToken
    {
        $token               = new APIToken();
        $token->key          = $this->key;
        $token->user_id      = $this->user_id;
        $token->requests     = $this->requests;
        $token->max_requests = $this->max_requests;
        $token->expires_at   = $this->expires_at;
        $token->readonly     = $this->readonly;

        return $token;
    }
}
